-- Up Migration
-- E-18: who saved each review revision (a person on the page), or null for
-- the first one and for fixes sent with an API key.
ALTER TABLE revisions ADD COLUMN created_by text REFERENCES users (id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE revisions DROP COLUMN created_by;
