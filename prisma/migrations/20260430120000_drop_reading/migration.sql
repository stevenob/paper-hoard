-- Drop the Reading table. Per-user reading-session tracking was an early
-- v2.2 feature that the household didn't use; removing it cleans up dead
-- code and ~1000 lines from the bundle. Backups never included readings
-- data so existing JSON exports remain restorable.
DROP TABLE IF EXISTS "Reading";
