-- Create Shelf + ShelfCopy
CREATE TABLE "Shelf" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isOrdered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Shelf_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Shelf_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Shelf_libraryId_slug_key" ON "Shelf"("libraryId", "slug");

CREATE TABLE "ShelfCopy" (
    "shelfId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "position" DOUBLE PRECISION,
    CONSTRAINT "ShelfCopy_pkey" PRIMARY KEY ("shelfId", "copyId"),
    CONSTRAINT "ShelfCopy_shelfId_fkey" FOREIGN KEY ("shelfId") REFERENCES "Shelf"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShelfCopy_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "PhysicalCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ShelfCopy_copyId_idx" ON "ShelfCopy"("copyId");

-- Migrate existing PhysicalCopy.location values into shelves
DO $$
DECLARE
  loc RECORD;
  shelf_id TEXT;
BEGIN
  FOR loc IN
    SELECT DISTINCT "libraryId", trim("location") AS loc_name
    FROM "PhysicalCopy"
    WHERE "location" IS NOT NULL AND trim("location") <> ''
  LOOP
    shelf_id := 'sh_' || substr(md5(loc."libraryId" || ':' || lower(loc.loc_name)), 1, 16);
    INSERT INTO "Shelf"(id, "libraryId", name, slug, "isOrdered", "createdAt")
    VALUES (
      shelf_id,
      loc."libraryId",
      loc.loc_name,
      lower(regexp_replace(loc.loc_name, '[^a-z0-9]+', '-', 'gi')),
      false,
      now()
    )
    ON CONFLICT DO NOTHING;
    INSERT INTO "ShelfCopy"("shelfId", "copyId")
    SELECT shelf_id, id FROM "PhysicalCopy"
    WHERE "libraryId" = loc."libraryId" AND trim("location") = loc.loc_name
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- Drop old fields and tables
ALTER TABLE "PhysicalCopy" DROP COLUMN "location";
ALTER TABLE "Book" DROP COLUMN "seriesName";
ALTER TABLE "Book" DROP COLUMN "seriesPosition";
DROP TABLE "BookTag";
DROP TABLE "Tag";
