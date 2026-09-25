-- Up Migration
-- E-05: organisations and API keys, outlines, uploads, documents, pages, revisions
-- and the model-call log. Every table carries org_id (spec #1 §6).

CREATE TABLE organisations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  name text NOT NULL,
  -- sha256 of the whole key. Keys are long random strings, so a fast hash is enough.
  hash bytea NOT NULL UNIQUE,
  -- The first characters, shown so a person can tell keys apart.
  prefix text NOT NULL,
  -- Which model provider this key's documents use (spec decision Q22).
  provider text NOT NULL DEFAULT 'openrouter' CHECK (provider IN ('openrouter', 'vertex')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX api_keys_org ON api_keys (org_id);

CREATE TABLE outlines (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  status text NOT NULL CHECK (status IN ('draft', 'confirmed', 'in_use')),
  source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX outlines_org ON outlines (org_id);

CREATE TABLE outline_nodes (
  outline_id text NOT NULL REFERENCES outlines (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organisations (id),
  id text NOT NULL,
  parent_id text,
  position integer NOT NULL,
  name text NOT NULL,
  level text,
  printed_from integer,
  printed_to integer,
  kind text NOT NULL CHECK (kind IN ('content', 'answer_key')),
  external_ref text,
  PRIMARY KEY (outline_id, id)
);

CREATE TABLE uploads (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  storage_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX uploads_org ON uploads (org_id);

CREATE TABLE documents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  api_key_id text NOT NULL REFERENCES api_keys (id),
  outline_id text NOT NULL REFERENCES outlines (id),
  type text NOT NULL CHECK (type IN ('questions', 'explanation', 'both')),
  language text,
  status text NOT NULL CHECK (status IN (
    'queued', 'rendering', 'awaiting_offset', 'processing',
    'completed', 'completed_with_errors', 'failed'
  )),
  -- { "kind": "pdf", "upload_id": … } or { "kind": "images", "upload_ids": [ … ] }
  source jsonb NOT NULL,
  webhook_url text,
  page_count integer,
  -- Page tasks not yet settled (read or failed for good). The task that brings
  -- it to 0 starts the finish step (ADR 0001).
  pages_pending integer NOT NULL DEFAULT 0,
  offset_segments jsonb,
  revision integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX documents_org ON documents (org_id, created_at DESC);
CREATE INDEX documents_key_status ON documents (api_key_id, status);

CREATE TABLE pages (
  document_id text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organisations (id),
  pdf_page integer NOT NULL,
  image_key text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'read', 'failed')),
  printed_number integer,
  reading jsonb,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  PRIMARY KEY (document_id, pdf_page)
);

-- The result, whole, per revision. Revision 1 is the pipeline's output; review
-- saves add the next number and never overwrite (ADR 0001).
CREATE TABLE revisions (
  document_id text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organisations (id),
  number integer NOT NULL,
  result jsonb NOT NULL,
  changes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, number)
);

-- Every model call: what it was for, its finish reason and what it cost.
CREATE TABLE model_calls (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  document_id text,
  purpose text NOT NULL,
  pdf_page integer,
  model text NOT NULL,
  finish_reason text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  ok boolean NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_document ON model_calls (document_id);

-- Down Migration
DROP TABLE model_calls;
DROP TABLE revisions;
DROP TABLE pages;
DROP TABLE documents;
DROP TABLE uploads;
DROP TABLE outline_nodes;
DROP TABLE outlines;
DROP TABLE api_keys;
DROP TABLE organisations;
