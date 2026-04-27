-- AlterTable
ALTER TABLE "Library" ADD COLUMN "publicSlug" TEXT;
CREATE UNIQUE INDEX "Library_publicSlug_key" ON "Library"("publicSlug");

-- CreateTable
CREATE TABLE "OutboundNotification" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "OutboundNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboundNotification_status_createdAt_idx" ON "OutboundNotification"("status", "createdAt");
