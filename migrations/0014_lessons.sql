-- Up Migration
-- Explainer videos (style A): a lesson script, its review state and its MP4.

CREATE TABLE lessons (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'auto_checked', 'in_review', 'approved', 'published')),
  -- The script (src/video/schema.ts), validated before every save.
  script jsonb NOT NULL,
  -- What the automatic checks found on the latest run: [{ level, scene_id, message }].
  findings jsonb NOT NULL DEFAULT '[]',
  -- The rendered MP4 in storage, its length, and the scenes that could not be rendered.
  video_key text,
  video_seconds real,
  failures jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lessons_org_idx ON lessons (org_id, created_at DESC);

-- Down Migration
DROP TABLE lessons;
