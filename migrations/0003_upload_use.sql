-- Up Migration
-- A book upload runs one document: its file is deleted when that job ends.
ALTER TABLE uploads ADD COLUMN document_id text;

-- Down Migration
ALTER TABLE uploads DROP COLUMN document_id;
