-- Up Migration
-- E-21: one-time links another platform makes (POST /v1/sessions) to send
-- its person into Engines' page for one outline or one document. The link's
-- token works once, for minutes; it becomes a visit (a cookie) for hours.
-- Only hashes are stored.
CREATE TABLE visitor_links (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id),
  -- The key that made the link: the visit acts through it (caps, provider).
  api_key_id text NOT NULL REFERENCES api_keys (id),
  outline_id text,
  document_id text,
  return_url text NOT NULL,
  -- Where the platform hears about documents the visit runs.
  webhook_url text,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  visit_hash bytea UNIQUE,
  visit_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outline_id IS NULL) <> (document_id IS NULL))
);
CREATE INDEX visitor_links_org ON visitor_links (org_id);

-- Down Migration
DROP TABLE visitor_links;
