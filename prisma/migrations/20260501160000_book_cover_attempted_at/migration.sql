-- v3.5.15: track when we last tried to fetch a cover so the backfill
-- helpers can skip books that have no cover available anywhere instead
-- of cycling them through every batch forever.
ALTER TABLE "Book" ADD COLUMN "coverAttemptedAt" TIMESTAMP(3);
