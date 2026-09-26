// Cuts a figure out of a stored page image (E-10, E-12, review crops in E-18).
import sharp from "sharp";
import type { CropBox } from "../contract/crop.ts";

/** Padding around the box, as a fraction of the page, so edges aren't clipped. */
export const CROP_PADDING = 0.01;

export async function cropImage(
  page: Buffer,
  box: CropBox,
  padding = CROP_PADDING,
): Promise<Buffer> {
  const { width, height } = await sharp(page).metadata();
  const left = Math.max(0, Math.floor((box.x - padding) * width));
  const top = Math.max(0, Math.floor((box.y - padding) * height));
  const right = Math.min(width, Math.ceil((box.x + box.w + padding) * width));
  const bottom = Math.min(
    height,
    Math.ceil((box.y + box.h + padding) * height),
  );
  if (right - left < 2 || bottom - top < 2)
    throw new Error("crop box is empty");
  return sharp(page)
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
}
