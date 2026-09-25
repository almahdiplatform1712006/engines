// `/v1/` outline shapes (spec #1 §3). The editor on Engines' page and the API
// both read these, so a node means the same thing everywhere.
import { z } from "zod";
import { MAX_SYLLABUS_PAGES } from "../shared/limits.ts";

export const PrintedRange = z.object({
  from: z.int().min(1),
  to: z.int().min(1),
});
export type PrintedRange = z.infer<typeof PrintedRange>;

export const NodeKind = z.enum(["content", "answer_key"]);
export type NodeKind = z.infer<typeof NodeKind>;

const NodeId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "node ids are letters, digits, _ and -");

/** A node as a client sends it. Ranges may be missing while the tree is a draft. */
export interface OutlineNodeInput {
  id?: string | undefined;
  name: string;
  level?: string | null | undefined;
  printed_pages?: PrintedRange | null | undefined;
  kind?: NodeKind | undefined;
  external_ref?: string | null | undefined;
  children?: OutlineNodeInput[] | undefined;
}

export const OutlineNodeInput: z.ZodType<OutlineNodeInput> = z.lazy(() =>
  z.object({
    id: NodeId.optional(),
    name: z.string().trim().min(1, "every node needs a name").max(500),
    level: z.string().max(100).nullable().optional(),
    printed_pages: PrintedRange.nullable().optional(),
    kind: NodeKind.optional(),
    external_ref: z.string().max(200).nullable().optional(),
    children: z.array(OutlineNodeInput).optional(),
  }),
);

/** A node as Engines stores and returns it: every field present. */
export interface OutlineNode {
  id: string;
  name: string;
  level: string | null;
  printed_pages: PrintedRange | null;
  kind: NodeKind;
  external_ref: string | null;
  children: OutlineNode[];
}

export const OutlineNode: z.ZodType<OutlineNode> = z.lazy(() =>
  z.object({
    id: NodeId,
    name: z.string(),
    level: z.string().nullable(),
    printed_pages: PrintedRange.nullable(),
    kind: NodeKind,
    external_ref: z.string().nullable(),
    children: z.array(OutlineNode),
  }),
);

export const OutlineIssue = z.object({
  code: z.enum([
    "missing_range",
    "inverted_range",
    "outside_parent",
    "sibling_overlap",
    "multiple_answer_keys",
    "duplicate_id",
    "gap",
  ]),
  node_id: z.string().nullable(),
  message: z.string(),
});
export type OutlineIssue = z.infer<typeof OutlineIssue>;

export const OutlineStatus = z.enum(["draft", "confirmed", "in_use"]);
export type OutlineStatus = z.infer<typeof OutlineStatus>;

const UploadId = z.string().min(1);

/**
 * Where a tree starts (spec §1 step 2):
 * - `manual`: the tree itself. A starting tree from another platform is one
 *   too, its nodes carrying `external_ref`; ranges may come later.
 * - `pdf`, `images` (in order), `book_pages` (the contents pages inside the
 *   book, as PDF pages): a syllabus the model drafts a tree from, one call
 *   per page. The book's `upload_id` is later sent to `POST /v1/documents`.
 */
export const CreateOutlineRequest = z.object({
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("manual"),
      nodes: z.array(OutlineNodeInput).min(1),
    }),
    z.object({ type: z.literal("pdf"), upload_id: UploadId }),
    z.object({
      type: z.literal("images"),
      upload_ids: z.array(UploadId).min(1).max(MAX_SYLLABUS_PAGES),
    }),
    z
      .object({
        type: z.literal("book_pages"),
        upload_id: UploadId,
        from: z.int().min(1),
        to: z.int().min(1),
      })
      .refine((s) => s.from <= s.to, "`from` must not be after `to`.")
      .refine(
        (s) => s.to - s.from < MAX_SYLLABUS_PAGES,
        `A syllabus is at most ${String(MAX_SYLLABUS_PAGES)} pages.`,
      ),
  ]),
});
export type CreateOutlineRequest = z.infer<typeof CreateOutlineRequest>;

export const ReplaceOutlineRequest = z.object({
  nodes: z.array(OutlineNodeInput).min(1),
});

/** How far drafting a tree from a syllabus has got. */
export const OutlineDrafting = z.object({
  status: z.enum(["running", "done", "failed"]),
  pages: z.int(),
  pages_read: z.int(),
  /** Syllabus pages that couldn't be read; the tree is drafted from the rest. */
  failures: z.array(z.object({ page: z.int(), reason: z.string() })),
});
export type OutlineDrafting = z.infer<typeof OutlineDrafting>;

export const Outline = z.object({
  id: z.string(),
  object: z.literal("outline"),
  status: OutlineStatus,
  /** Null for a tree that was sent; otherwise drafting's progress. */
  drafting: OutlineDrafting.nullable(),
  /** The syllabus pages, as images, for checking the tree against. */
  source_pages: z.array(
    z.object({ page: z.int(), image_url: z.string().nullable() }),
  ),
  nodes: z.array(OutlineNode),
  errors: z.array(OutlineIssue),
  warnings: z.array(OutlineIssue),
  created_at: z.string(),
  expires_at: z.string(),
});
export type Outline = z.infer<typeof Outline>;
