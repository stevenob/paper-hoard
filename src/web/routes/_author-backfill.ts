import { prisma } from "../../shared/db.js";
import { lookupByIsbn } from "../../shared/metadata.js";
import { logger } from "../../shared/logger.js";
import type { BackfillResult, RepairResultRow } from "./_cover-backfill.js";

/**
 * Fill in Book.primaryAuthor for rows where it's null.
 *
 * Two phases:
 *   1. Cheap — books whose authors[] array already has at least one entry.
 *      Just copy authors[0] into primaryAuthor. Instant, no network.
 *   2. Network — books with both primaryAuthor=null AND authors=[]. Look
 *      up via Google Books / Open Library by ISBN and take meta.authors[0].
 *
 * Cheap rows are processed first so the user sees instant progress; the
 * batch size is interpreted as "up to N total" and the cheap pass is
 * exhausted before any network calls happen.
 *
 * Books with neither authors[] nor isbn13 to look up are reported as
 * failed ("no source available") so the user knows they were tried.
 *
 * Same return contract as the cover repair helpers — the front-end
 * activity log is shared across all repair runs.
 */
export async function fillMissingAuthors(batchSize: number): Promise<BackfillResult> {
  const candidates = await prisma.book.findMany({
    where: { primaryAuthor: null },
    select: {
      id: true,
      isbn13: true,
      title: true,
      authors: true,
      thumbnailUrl: true,
      physicalCopies: {
        where: { deletedAt: null },
        select: { id: true },
        take: 1,
        orderBy: { addedAt: "asc" },
      },
    },
    // Order so cheap (authors non-empty) candidates come first. Postgres
    // can't easily sort by array length in a portable way; instead we
    // pull a generous slice and partition in JS.
    take: batchSize * 2,
    orderBy: { createdAt: "asc" },
  });

  const cheap = candidates.filter((c) => (c.authors?.length ?? 0) > 0);
  const networkBound = candidates.filter((c) => (c.authors?.length ?? 0) === 0);

  // Process cheap first, then as many network-bound as the batch budget allows.
  const toProcess = [...cheap, ...networkBound].slice(0, batchSize);

  let updated = 0;
  const results: RepairResultRow[] = [];

  for (const c of toProcess) {
    const copyId = c.physicalCopies[0]?.id ?? null;
    const baseRow = {
      bookId: c.id,
      copyId,
      title: c.title,
      thumbnailUrl: c.thumbnailUrl,
    };

    const fromArray = c.authors?.[0];
    if (fromArray) {
      try {
        await prisma.book.update({
          where: { id: c.id },
          data: { primaryAuthor: fromArray },
        });
        updated++;
        results.push({
          ...baseRow,
          author: fromArray,
          action: "repaired",
          detail: `(none) → ${fromArray}`,
        });
      } catch (err) {
        logger.warn({ err, bookId: c.id }, "primaryAuthor update failed");
        results.push({
          ...baseRow,
          author: null,
          action: "failed",
          detail: "db update error",
        });
      }
      continue;
    }

    if (!c.isbn13) {
      results.push({
        ...baseRow,
        author: null,
        action: "failed",
        detail: "no authors[] and no ISBN",
      });
      continue;
    }

    try {
      const meta = await lookupByIsbn(c.isbn13);
      const found = meta?.authors?.[0];
      if (found) {
        await prisma.book.update({
          where: { id: c.id },
          data: {
            primaryAuthor: found,
            // Persist the full authors list too so future runs hit the
            // cheap path. The metadata fetch is what was expensive; we
            // already paid for it, so capture everything useful.
            authors: meta!.authors.length > 0 ? meta!.authors : undefined,
          },
        });
        updated++;
        results.push({
          ...baseRow,
          author: found,
          action: "repaired",
          detail: `${meta!.source === "google_books" ? "Google" : "OL"} → ${found}`,
        });
      } else {
        results.push({
          ...baseRow,
          author: null,
          action: "failed",
          detail: "no authors at any source",
        });
      }
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "missing-author lookup failed");
      results.push({
        ...baseRow,
        author: null,
        action: "failed",
        detail: "lookup error",
      });
    }
  }

  const remaining = await prisma.book.count({
    where: { primaryAuthor: null },
  });

  return { processed: toProcess.length, updated, remaining, results };
}
