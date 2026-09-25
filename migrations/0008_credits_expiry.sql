-- Up Migration
-- E-14: prepaid page credits, and the 30-day expiry.

-- The balance is the sum of `pages`. A grant adds; a document holds its page
-- count when it's created, releases the hold when it ends, and writes one
-- usage entry for the pages it read.
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  kind text NOT NULL CHECK (kind IN ('grant', 'hold', 'release', 'usage')),
  pages integer NOT NULL,
  document_id text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_org ON credit_ledger (org_id, created_at);
-- One hold, one release and one usage entry per document, however often a
-- step is retried.
CREATE UNIQUE INDEX credit_ledger_document_kind ON credit_ledger (document_id, kind)
  WHERE document_id IS NOT NULL;

-- A document past its 30 days keeps a tombstone row, so it answers 410.
ALTER TABLE documents ADD COLUMN expired_at timestamptz;
-- The pages a document was billed for.
ALTER TABLE documents ADD COLUMN pages_billed integer;
CREATE INDEX documents_expires ON documents (expires_at) WHERE expired_at IS NULL;

-- Down Migration
DROP INDEX documents_expires;
ALTER TABLE documents DROP COLUMN pages_billed;
ALTER TABLE documents DROP COLUMN expired_at;
DROP TABLE credit_ledger;
