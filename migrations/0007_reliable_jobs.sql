-- Up Migration
-- E-13: per-key caps, idempotency, the same-file warning and signed webhooks.

-- How many documents a key runs at once, and how many may wait behind them.
ALTER TABLE api_keys ADD COLUMN concurrency integer NOT NULL DEFAULT 2 CHECK (concurrency BETWEEN 1 AND 50);
ALTER TABLE api_keys ADD COLUMN max_queued integer NOT NULL DEFAULT 20 CHECK (max_queued BETWEEN 0 AND 1000);

-- A fingerprint of the book's bytes (from storage), for "you processed this
-- exact file N days ago", and the warning shown with the document.
ALTER TABLE documents ADD COLUMN file_hash text;
ALTER TABLE documents ADD COLUMN warning jsonb;
CREATE INDEX documents_file_hash ON documents (org_id, file_hash);

-- Signs webhooks. One per organisation, generated on first use.
ALTER TABLE organisations ADD COLUMN webhook_secret text;

-- A repeated POST with the same Idempotency-Key within 24 hours returns the
-- original response. `response_status` is null while the first is in flight.
CREATE TABLE idempotency_keys (
  org_id text NOT NULL REFERENCES organisations (id),
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);

CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  document_id text NOT NULL,
  url text NOT NULL,
  payload jsonb NOT NULL,
  attempt integer NOT NULL,
  status_code integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_document ON webhook_deliveries (document_id);

-- Down Migration
DROP TABLE webhook_deliveries;
DROP TABLE idempotency_keys;
ALTER TABLE organisations DROP COLUMN webhook_secret;
DROP INDEX documents_file_hash;
ALTER TABLE documents DROP COLUMN warning;
ALTER TABLE documents DROP COLUMN file_hash;
ALTER TABLE api_keys DROP COLUMN max_queued;
ALTER TABLE api_keys DROP COLUMN concurrency;
