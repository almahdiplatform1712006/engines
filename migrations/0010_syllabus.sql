-- Up Migration
-- E-16: an outline drafted from a syllabus (pdf, photos, or the contents pages
-- inside the book). One row per syllabus page: its image, for the editor's
-- side panel, and what the model read on it.

-- running while pages are read; done or failed once every page is settled.
-- Null for outlines sent as a tree.
ALTER TABLE outlines ADD COLUMN drafting text CHECK (drafting IN ('running', 'done', 'failed'));
-- The key the outline was made with: its provider reads the syllabus.
ALTER TABLE outlines ADD COLUMN api_key_id text REFERENCES api_keys (id);

CREATE TABLE outline_pages (
  outline_id text NOT NULL REFERENCES outlines (id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organisations (id),
  -- Its place in the syllabus, from 1.
  page integer NOT NULL,
  image_key text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'read', 'failed')),
  entries jsonb,
  failure text,
  PRIMARY KEY (outline_id, page)
);

-- Down Migration
DROP TABLE outline_pages;
ALTER TABLE outlines DROP COLUMN api_key_id;
ALTER TABLE outlines DROP COLUMN drafting;
