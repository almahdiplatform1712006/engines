-- Up Migration
-- E-20: every change made in the owner's back office, who made it, when.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id text REFERENCES users (id) ON DELETE SET NULL,
  -- The organisation the change is about, when it's about one.
  org_id text REFERENCES organisations (id),
  action text NOT NULL,
  target text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);

-- Back-office job lists sort by recency across organisations.
CREATE INDEX documents_created ON documents (created_at DESC);

-- Down Migration
DROP INDEX documents_created;
DROP TABLE audit_log;
