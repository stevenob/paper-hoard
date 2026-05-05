-- v3.6: Kindle ASIN link-out support. Three additive nullable columns
-- on Book to enable a "📖 Read on Kindle" button on owned books.
--
-- kindleAsin is the Amazon ASIN of the Kindle ebook edition (10 chars,
-- typically B0…). Distinct from print ISBN-10/ISBN-13. Used to build
-- the Cloud Reader URL.
--
-- kindleAsinSource is "manual" (user-curated, never auto-overwritten)
-- or "open_library" (auto-fetched, replaceable). NULL when no value
-- has been set yet.
--
-- kindleAsinAttemptedAt mirrors the coverAttemptedAt cooldown pattern
-- so a book OL doesn't know doesn't get re-fetched on every scan.
--
-- No index, no uniqueness — added later only if a query starts
-- filtering by kindleAsin.
ALTER TABLE "Book" ADD COLUMN "kindleAsin" TEXT;
ALTER TABLE "Book" ADD COLUMN "kindleAsinSource" TEXT;
ALTER TABLE "Book" ADD COLUMN "kindleAsinAttemptedAt" TIMESTAMP(3);
