-- Series tracking on Book — reintroduced. v2.0 dropped series in favor of
-- shelves, but for collectors "Foundation #3" is a primary axis of
-- organization, not a tag. Not autopopulated yet; users add manually.
ALTER TABLE "Book" ADD COLUMN "seriesName"     TEXT;
ALTER TABLE "Book" ADD COLUMN "seriesPosition" DOUBLE PRECISION;
CREATE INDEX "Book_seriesName_idx" ON "Book"("seriesName");

-- Edition fidelity on PhysicalCopy. Nullable booleans so existing rows
-- default to "unknown" rather than implicit false. printLine is the
-- raw number-line text from the copyright page (e.g. "10 9 8 7 6 5 4 3 2 1").
ALTER TABLE "PhysicalCopy" ADD COLUMN "firstEdition"      BOOLEAN;
ALTER TABLE "PhysicalCopy" ADD COLUMN "firstPrinting"     BOOLEAN;
ALTER TABLE "PhysicalCopy" ADD COLUMN "signed"            BOOLEAN;
ALTER TABLE "PhysicalCopy" ADD COLUMN "inscribed"         BOOLEAN;
ALTER TABLE "PhysicalCopy" ADD COLUMN "dustJacketPresent" BOOLEAN;
ALTER TABLE "PhysicalCopy" ADD COLUMN "printLine"         TEXT;

-- Migrate the old casual condition values to the antiquarian grading
-- standard. Lossy by design: "new" → "Fine", "like-new" → "Near Fine",
-- "good" → "Very Good", "fair" → "Good", "poor" → "Poor".
UPDATE "PhysicalCopy" SET "condition" = 'Fine'      WHERE "condition" = 'new';
UPDATE "PhysicalCopy" SET "condition" = 'Near Fine' WHERE "condition" = 'like-new';
UPDATE "PhysicalCopy" SET "condition" = 'Very Good' WHERE "condition" = 'good';
UPDATE "PhysicalCopy" SET "condition" = 'Good'      WHERE "condition" = 'fair';
UPDATE "PhysicalCopy" SET "condition" = 'Poor'      WHERE "condition" = 'poor';

-- Trophy extensions: max purchase price (in cents to dodge float rounding),
-- edition specifics ("must be 1st UK printing"), and a soft-archive status
-- so seldomly-active trophies can drop out of the offline scan cache.
ALTER TABLE "Trophy" ADD COLUMN "maxPriceCents" INTEGER;
ALTER TABLE "Trophy" ADD COLUMN "editionNotes"  TEXT;
ALTER TABLE "Trophy" ADD COLUMN "status"        TEXT NOT NULL DEFAULT 'active';
CREATE INDEX "Trophy_status_idx" ON "Trophy"("status");
