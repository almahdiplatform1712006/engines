-- Up Migration
-- E-09: processing runs in stages (read → pair → solve → finish). Stages after
-- the page reads fan out into tasks, counted down like pages (ADR 0001).
ALTER TABLE documents ADD COLUMN stage text NOT NULL DEFAULT 'read'
  CHECK (stage IN ('read', 'pair', 'solve', 'finish'));
ALTER TABLE documents ADD COLUMN tasks_pending integer NOT NULL DEFAULT 0;

CREATE TABLE tasks (
  document_id text NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organisations (id),
  stage text NOT NULL CHECK (stage IN ('pair', 'solve')),
  key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  input jsonb NOT NULL,
  output jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, stage, key)
);

-- Down Migration
DROP TABLE tasks;
ALTER TABLE documents DROP COLUMN tasks_pending;
ALTER TABLE documents DROP COLUMN stage;
