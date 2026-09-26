-- Up Migration
-- E-12: switches on an organisation. Today only `explanation` (spec decision Q8).
CREATE TABLE entitlements (
  org_id text NOT NULL REFERENCES organisations (id),
  name text NOT NULL CHECK (name IN ('explanation')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

-- Down Migration
DROP TABLE entitlements;
