-- Up Migration
-- E-07: the quick pass and the offset confirmation.

-- `auto` confirms a well-agreeing fit without asking (spec §3 `offset: "auto"`).
ALTER TABLE documents ADD COLUMN offset_mode text NOT NULL DEFAULT 'confirm'
  CHECK (offset_mode IN ('confirm', 'auto'));
ALTER TABLE documents ADD COLUMN offset_agreement real;
ALTER TABLE documents ADD COLUMN offset_confirmed_at timestamptz;

-- What the quick pass read on a sampled page.
ALTER TABLE pages ADD COLUMN quick_read boolean NOT NULL DEFAULT false;
ALTER TABLE pages ADD COLUMN quick_raw text;
ALTER TABLE pages ADD COLUMN quick_number integer;
-- The PDF's own page label, when it sets one.
ALTER TABLE pages ADD COLUMN label text;

-- Down Migration
ALTER TABLE pages DROP COLUMN label;
ALTER TABLE pages DROP COLUMN quick_number;
ALTER TABLE pages DROP COLUMN quick_raw;
ALTER TABLE pages DROP COLUMN quick_read;
ALTER TABLE documents DROP COLUMN offset_confirmed_at;
ALTER TABLE documents DROP COLUMN offset_agreement;
ALTER TABLE documents DROP COLUMN offset_mode;
