import { prisma } from "../../shared/db.js";
import { lookupByIsbn } from "../../shared/metadata.js";
import { logger } from "../../shared/logger.js";

/**
 * Process up to `batchSize` books with no thumbnailUrl by re-running the
 * metadata fetcher. Designed to be called repeatedly from the web UI so a
 * progress bar can render — each call returns the count processed and the
 * count still remaining.
 *
 * Books with no isbn13 are skipped (we have no way to look them up).
 */
export async function refetchMissingCovers(batchSize: number): Promise<{
  processed: number;
  updated: number;
  remaining: number;
}> {
  const candidates = await prisma.book.findMany({
    where: { thumbnailUrl: null, isbn13: { not: null } },
    select: { id: true, isbn13: true },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  for (const c of candidates) {
    if (!c.isbn13) continue;
    try {
      const meta = await lookupByIsbn(c.isbn13);
      if (meta?.thumbnailUrl) {
        await prisma.book.update({
          where: { id: c.id },
          data: {
            thumbnailUrl: meta.thumbnailUrl,
            // Refresh other potentially-improved fields too, but don't
            // touch source — preserve "manual" markers.
            publisher: meta.publisher ?? undefined,
            publishedAt: meta.publishedAt ?? undefined,
          },
        });
        updated++;
      }
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "cover backfill failed for book");
    }
  }

  const remaining = await prisma.book.count({
    where: { thumbnailUrl: null, isbn13: { not: null } },
  });

  return { processed: candidates.length, updated, remaining };
}
