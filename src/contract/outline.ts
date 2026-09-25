// `/v1/` outline shapes (spec #1 §3). The editor on Engines' page and the API
// both read these, so a node means the same thing everywhere.
import { z } from "zod";

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

export const CreateOutlineRequest = z.object({
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("manual"),
      nodes: z.array(OutlineNodeInput).min(1),
    }),
  ]),
});
export type CreateOutlineRequest = z.infer<typeof CreateOutlineRequest>;

export const ReplaceOutlineRequest = z.object({
  nodes: z.array(OutlineNodeInput).min(1),
});

export const Outline = z.object({
  id: z.string(),
  object: z.literal("outline"),
  status: OutlineStatus,
  nodes: z.array(OutlineNode),
  errors: z.array(OutlineIssue),
  warnings: z.array(OutlineIssue),
  created_at: z.string(),
  expires_at: z.string(),
});
export type Outline = z.infer<typeof Outline>;
