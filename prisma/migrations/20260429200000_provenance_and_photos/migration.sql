-- Provenance: where the copy came from, when, and what it cost (in cents).
ALTER TABLE "PhysicalCopy" ADD COLUMN "acquiredFrom" TEXT;
ALTER TABLE "PhysicalCopy" ADD COLUMN "acquiredOn"   TIMESTAMP(3);
ALTER TABLE "PhysicalCopy" ADD COLUMN "priceCents"   INTEGER;

CREATE INDEX "PhysicalCopy_priceCents_idx" ON "PhysicalCopy"("priceCents");

-- Multi-photo gallery per copy. The existing PhysicalCopy.coverPath remains
-- the primary cover used in poster grids and exports; CopyPhoto rows are
-- supplemental (dust jacket, signed page, damage, marginalia, etc).
CREATE TABLE "CopyPhoto" (
    "id"        TEXT NOT NULL,
    "copyId"    TEXT NOT NULL,
    "photoPath" TEXT NOT NULL,
    "label"     TEXT,
    "position"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CopyPhoto_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CopyPhoto_copyId_fkey" FOREIGN KEY ("copyId")
        REFERENCES "PhysicalCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CopyPhoto_copyId_idx" ON "CopyPhoto"("copyId");
