ALTER TABLE "PhysicalCopy" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "PhysicalCopy_deletedAt_idx" ON "PhysicalCopy"("deletedAt");

CREATE TABLE "Reading" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "notes" TEXT,
    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Reading_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reading_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reading_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "PhysicalCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Reading_userId_finishedAt_idx" ON "Reading"("userId", "finishedAt");
CREATE INDEX "Reading_libraryId_finishedAt_idx" ON "Reading"("libraryId", "finishedAt");
