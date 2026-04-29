-- Enable pg_trgm for similarity-based fuzzy search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes accelerate `%`, `<%`, similarity() and ILIKE on these columns.
CREATE INDEX IF NOT EXISTS "Book_title_trgm_idx"
  ON "Book" USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Book_primaryAuthor_trgm_idx"
  ON "Book" USING gin ("primaryAuthor" gin_trgm_ops);
