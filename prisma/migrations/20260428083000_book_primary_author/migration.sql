ALTER TABLE "Book" ADD COLUMN "primaryAuthor" TEXT;
-- Backfill: take the first author from the authors[] array.
UPDATE "Book" SET "primaryAuthor" = "authors"[1] WHERE array_length("authors", 1) > 0;
CREATE INDEX "Book_primaryAuthor_idx" ON "Book"("primaryAuthor");
