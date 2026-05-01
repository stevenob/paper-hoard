-- Lending tracker fields. lentTo is free-text since most lending is to
-- people outside the household (friends, family, neighbors) who don't
-- have Discord accounts. dueBack is optional — many loans are open-ended.
ALTER TABLE "PhysicalCopy" ADD COLUMN "lentTo"   TEXT;
ALTER TABLE "PhysicalCopy" ADD COLUMN "lentAt"   TIMESTAMP(3);
ALTER TABLE "PhysicalCopy" ADD COLUMN "dueBack"  TIMESTAMP(3);

CREATE INDEX "PhysicalCopy_lentTo_idx" ON "PhysicalCopy"("lentTo");
