// Drag a crop box on a page image: drag on the page to draw one, drag the box
// to move it, drag its corner to resize it. The box is kept as fractions of
// the page (0–1), as the API takes it. The image's own coordinates run left
// to right whatever the page's direction, so this one area is `dir="ltr"`.
import { useRef, useState } from "react";
import type { CropBox } from "../../src/contract/crop.ts";

type Drag =
  | { mode: "draw"; x: number; y: number }
  | { mode: "move"; dx: number; dy: number }
  | { mode: "resize" };

const clamp = (v: number) => Math.min(Math.max(v, 0), 1);

export function CropEditor(props: {
  src: string;
  alt: string;
  box: CropBox | null;
  onChange: (box: CropBox) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { box } = props;

  const at = (e: React.PointerEvent) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
    };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    if (drag.mode === "draw") {
      props.onChange({
        x: Math.min(drag.x, p.x),
        y: Math.min(drag.y, p.y),
        w: Math.abs(p.x - drag.x),
        h: Math.abs(p.y - drag.y),
      });
    } else if (drag.mode === "move" && box) {
      props.onChange({
        ...box,
        x: clamp(Math.min(p.x - drag.dx, 1 - box.w)),
        y: clamp(Math.min(p.y - drag.dy, 1 - box.h)),
      });
    } else if (drag.mode === "resize" && box) {
      props.onChange({
        ...box,
        w: Math.max(clamp(p.x) - box.x, 0.01),
        h: Math.max(clamp(p.y) - box.y, 0.01),
      });
    }
  };

  // The area captures the pointer for the whole drag, so moves and the
  // release land here once, wherever the pointer goes.
  const start = (e: React.PointerEvent, next: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    area.current?.setPointerCapture(e.pointerId);
    setDrag(next);
  };
  const stop = () => {
    setDrag(null);
  };

  return (
    <div
      ref={area}
      className="crop-area"
      dir="ltr"
      data-testid="crop-area"
      onPointerDown={(e) => {
        start(e, { mode: "draw", ...at(e) });
      }}
      onPointerMove={onMove}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      <img src={props.src} alt={props.alt} draggable={false} />
      {box && (
        <div
          className="crop-box"
          data-testid="crop-box"
          style={{
            insetInlineStart: `${String(box.x * 100)}%`,
            insetBlockStart: `${String(box.y * 100)}%`,
            inlineSize: `${String(box.w * 100)}%`,
            blockSize: `${String(box.h * 100)}%`,
          }}
          onPointerDown={(e) => {
            const p = at(e);
            start(e, { mode: "move", dx: p.x - box.x, dy: p.y - box.y });
          }}
        >
          <span
            className="crop-handle"
            onPointerDown={(e) => {
              start(e, { mode: "resize" });
            }}
          />
        </div>
      )}
    </div>
  );
}
