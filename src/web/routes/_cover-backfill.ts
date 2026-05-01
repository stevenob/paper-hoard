import { prisma } from "../../shared/db.js";
import { lookupByIsbn } from "../../shared/metadata.js";
import { logger } from "../../shared/logger.js";
import { olCoverUrlByIsbn, pickValidCover } from "../../shared/cover-validation.js";

interface BackfillResult {
  processed: number;
  updated: number;
  remaining: number;
}

/**
 * Process up to `batchSize` books with no thumbnailUrl by re-running the
 * metadata fetcher. Designed to be called repeatedly from the web UI so a
 * progress bar can render — each call returns the count processed and the
 * count still remaining.
 *
 * Books with no isbn13 are skipped (we have no way to look them up).
 * Each candidate's URL is validated; falls through to OL by ISBN when
 * Google's URL is a placeholder.
 */
export async function refetchMissingCovers(batchSize: number): Promise<BackfillResult> {
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
      // Validating cascade — never store a placeholder JPEG when we can
      // fall back to OL or end up null instead.
      const validated = await pickValidCover(
        meta?.thumbnailUrl,
        olCoverUrlByIsbn(c.isbn13, "L"),
        olCoverUrlByIsbn(c.isbn13, "M")
      );
      if (validated || meta) {
        await prisma.book.update({
          where: { id: c.id },
          data: {
            thumbnailUrl: validated,
            // Refresh other potentially-improved fields too, but don't
            // touch source — preserve "manual" markers.
            publisher: meta?.publisher ?? undefined,
            publishedAt: meta?.publishedAt ?? undefined,
          },
        });
        if (validated) updated++;
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

/**
 * Refresh existing thumbnails to higher-resolution (or simply working)
 * versions. Targets books whose thumbnailUrl matches known low-res or
 * placeholder-prone patterns. For each candidate it now runs through a
 * validating cascade — fetch fresh metadata, validate Google Books URL,
 * fall back to Open Library -L then -M when broken, or null out the URL
 * entirely if no source has a real image.
 *
 * Books marked source: 'manual' are skipped to preserve user uploads.
 */
export async function refreshLowResCovers(batchSize: number): Promise<BackfillResult> {
  const lowResWhere = {
    isbn13: { not: null },
    thumbnailUrl: { not: null },
    source: { not: "manual" },
    OR: [
      { thumbnailUrl: { contains: "zoom=1" } },
      { thumbnailUrl: { contains: "zoom=0" } },
      { thumbnailUrl: { contains: "edge=curl" } },
      { thumbnailUrl: { contains: "-M.jpg" } },
      { thumbnailUrl: { contains: "-S.jpg" } },
      { thumbnailUrl: { startsWith: "http://" } },
    ],
  };

  const candidates = await prisma.book.findMany({
    where: lowResWhere as never,
    select: { id: true, isbn13: true },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  for (const c of candidates) {
    if (!c.isbn13) continue;
    try {
      // Step 1: refresh metadata. Picks up the v3.5.2 zoom=2 URL plus any
      // other recently-improved fields.
      const meta = await lookupByIsbn(c.isbn13);
      // Step 2: validate the candidate URLs in order. Google's zoom=2 URL
      // sometimes returns the "image not available" placeholder for niche
      // books — fall through to OL by ISBN at -L then -M when that
      // happens. ?default=false makes OL 404 rather than serve a blank gif.
      const validated = await pickValidCover(
        meta?.thumbnailUrl,
        olCoverUrlByIsbn(c.isbn13, "L"),
        olCoverUrlByIsbn(c.isbn13, "M")
      );
      // Whatever we found (or null) is what gets saved. Null is the right
      // value when no source has a real cover — the UI's fallback poster
      // is better than a Google placeholder JPEG.
      await prisma.book.update({
        where: { id: c.id },
        data: { thumbnailUrl: validated },
      });
      if (validated) updated++;
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "cover refresh failed for book");
    }
  }

  const remaining = await prisma.book.count({ where: lowResWhere as never });

  return { processed: candidates.length, updated, remaining };
}
