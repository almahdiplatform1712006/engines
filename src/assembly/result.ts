// The result as stored in a revision. Same as the `/v1/` shapes, except images:
// a stored image is a crop of a page image, kept as its storage key and box so
// it can be re-cropped in review; the API turns it into a signed URL.
import type { CropBox } from "../contract/crop.ts";
import type {
  ExplanationChunk,
  Failure,
  Question,
  Stimulus,
} from "../contract/document.ts";

export interface StoredImage {
  pdf_page: number;
  box: CropBox;
  /** Where the crop is stored; null until it has been cut (or when cutting failed). */
  key: string | null;
}

export type StoredQuestion = Omit<Question, "image"> & {
  image: StoredImage | null;
};
export type StoredStimulus = Omit<Stimulus, "image"> & {
  image: StoredImage | null;
};
export type StoredChunk = Omit<ExplanationChunk, "figures"> & {
  figures: StoredImage[];
};

export type StoredFailure = Omit<Failure, "page_image">;

export interface ResultBody {
  stimuli: StoredStimulus[];
  questions: StoredQuestion[];
  explanation: StoredChunk[];
  skipped: { neither: number; off_type: number };
  failures: StoredFailure[];
}
