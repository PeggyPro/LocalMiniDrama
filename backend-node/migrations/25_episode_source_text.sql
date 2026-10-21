-- Keep original source separate from optional adaptation instructions and output script.
-- Existing description/script_content are intentionally left intact. No source is inferred.
ALTER TABLE episodes ADD COLUMN source_text TEXT;
