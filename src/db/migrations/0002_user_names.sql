-- 0002_user_names.sql
-- Split user identity from a single `display_name` into structured
-- `first_name` / `last_name` columns.
--
-- Why additive (rather than DROP COLUMN display_name):
--   - `display_name` is still a useful presentation field. The API
--     continues to surface a `displayName` in the /me payload, but it
--     is now COMPUTED from first + last name on the way out (with
--     legacy display_name as a fallback for any pre-existing rows
--     that haven't been re-edited yet).
--   - Onboarding asks for first + last name explicitly, so future
--     rows always carry the structured form.
--
-- Backfill is best-effort: split the trimmed display_name on the
-- first whitespace run. Any single-token name becomes (first_name,
-- NULL); the rest stays in last_name as-is. Rows without a
-- display_name are left untouched (NULL on both new columns).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT;

UPDATE users
SET
  first_name = NULLIF(split_part(trim(display_name), ' ', 1), ''),
  last_name  = NULLIF(
    regexp_replace(trim(display_name), '^\S+\s*', ''),
    ''
  )
WHERE display_name IS NOT NULL
  AND first_name IS NULL
  AND last_name  IS NULL;
