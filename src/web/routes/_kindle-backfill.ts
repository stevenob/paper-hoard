import { prisma } from "../../shared/db.js";
import { logger } from "../../shared/logger.js";
import { enrichKindleAsin } from "../../shared/kindle-enrichment.js";
import type {
  BackfillResult,
  RepairResultRow,
  RepairScope,
} from "./_cover-backfill.js";

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// Open Library's `/search.json` endpoint enforces a per-IP rate
// limit. Hitting it 25 times in a tight loop reliably trips it; we
// learned this the hard way in v3.6.1 where 524 of 525 books came
// back as ECONNRESET errors that got reported (misleadingly) as
// "no Kindle ASIN at OL". 350 ms between calls keeps us well under
// OL's documented "100 requests / 5 minutes" budget while still
// finishing a 500-book library in a few minutes.
const PER_BOOK_DELAY_MS = 350;
// Smaller batches mean the front-end paints progress more often
// AND the per-batch wall-time is short enough that OL's connection
// pool won't see a sustained-rate burst.
const BATCH_SIZE = 10;

export const KINDLE_BACKFILL_BATCH_SIZE = BATCH_SIZE;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill `Book.kindleAsin` for books in the caller's library that
 * don't have one yet. Mirrors the cover-backfill / fill-authors
 * pattern so the /about page UI plugs straight in.
 *
 * Candidate selection:
 *   - has an ISBN-13 (OL search needs one)
 *   - kindleAsin IS NULL
 *   - cooldown expired or never attempted (unless ignoreCooldown)
 *   - manual ASINs are excluded — they're never null AND would have
 *     a "manual" source anyway, but we filter explicitly for
 *     belt-and-braces clarity
 *   - has at least one non-deleted PhysicalCopy in scope (so we
 *     don't waste OL hits on books no one in this library owns
 *     anymore)
 *
 * Each book is processed by `enrichKindleAsin` in `reportResult`
 * mode. The atomic claim inside that helper makes this safe to
 * call concurrently with live request-driven enrichments — both
 * paths cooperate via the same cooldown column.
 *
 * The OL-call delay between books is enforced by enrichKindleAsin's
 * own queue (250ms between jobs). The backfill helper itself is
 * synchronous-serial: it awaits each enrichKindleAsin in turn so
 * the activity log renders cleanly and the in-flight OL load stays
 * gentle.
 */
export async function backfillKindleAsins(
  batchSize: number,
  scope: RepairScope
): Promise<BackfillResult> {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS);
  const cooldownClause = scope.ignoreCooldown
    ? {}
    : {
        OR: [
          { kindleAsinAttemptedAt: null },
          { kindleAsinAttemptedAt: { lt: cooldownCutoff } as const },
        ],
      };
  const where = {
    isbn13: { not: null },
    kindleAsin: null,
    AND: [
      {
        OR: [
          { kindleAsinSource: { not: "manual" } as const },
          { kindleAsinSource: null },
        ],
      },
      cooldownClause,
    ],
    ...(scope.libraryId
      ? { physicalCopies: { some: { libraryId: scope.libraryId, deletedAt: null } } }
      : { physicalCopies: { some: { deletedAt: null } } }),
  };

  const candidates = await prisma.book.findMany({
    where,
    select: {
      id: true,
      title: true,
      primaryAuthor: true,
      thumbnailUrl: true,
      physicalCopies: {
        where: { deletedAt: null, ...(scope.libraryId ? { libraryId: scope.libraryId } : {}) },
        select: { id: true },
        take: 1,
        orderBy: { addedAt: "asc" },
      },
    },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  const results: RepairResultRow[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const baseRow = {
      bookId: c.id,
      copyId: c.physicalCopies[0]?.id ?? null,
      title: c.title,
      author: c.primaryAuthor,
      thumbnailUrl: c.thumbnailUrl,
    };
    try {
      const r = await enrichKindleAsin(c.id, {
        ignoreCooldown: scope.ignoreCooldown,
        reportResult: true,
      });
      switch (r.status) {
        case "updated":
          updated++;
          results.push({
            ...baseRow,
            action: "repaired",
            detail: `OL → ${r.asin}`,
          });
          break;
        case "unchanged":
          // Already had the same OL value before this run; bookkeeping
          // refresh only. Surfaced as "kept" so the activity log shows
          // it as a no-op rather than a failure.
          results.push({
            ...baseRow,
            action: "kept",
            detail: `OL re-confirmed ${r.asin}`,
          });
          break;
        case "ol-error":
          // Transient: OL rate limited us, dropped the connection,
          // or returned a 5xx. NOT a coverage gap; the user can hit
          // "↻ Retry orphans" later to re-attempt without the 7-day
          // cooldown. Distinct message so they know to retry.
          results.push({
            ...baseRow,
            action: "failed",
            detail:
              r.cause === "network"
                ? "OL request failed (network/rate-limit)"
                : "OL request failed (HTTP error)",
          });
          break;
        case "no-asin-found":
          results.push({
            ...baseRow,
            action: "failed",
            detail: "no Kindle ASIN at OL",
          });
          break;
        case "manual-locked":
          // Filter excludes these, but defend against drift.
          results.push({
            ...baseRow,
            action: "kept",
            detail: "manual ASIN protected",
          });
          break;
        case "in-cooldown":
          results.push({
            ...baseRow,
            action: "kept",
            detail: "still in cooldown",
          });
          break;
        case "no-isbn":
          results.push({
            ...baseRow,
            action: "failed",
            detail: "no ISBN-13",
          });
          break;
      }
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "kindle ASIN backfill row failed");
      results.push({
        ...baseRow,
        action: "failed",
        detail: "lookup error",
      });
    }
    // Throttle: be polite to Open Library. The single OL request
    // per book is cheap, but 25-in-a-row reliably trips OL's
    // per-IP rate limit. Skip the sleep after the last book in
    // the batch since the front-end's 250ms inter-batch delay
    // already provides a gap before the next call.
    if (i < candidates.length - 1) await sleep(PER_BOOK_DELAY_MS);
  }

  // Recompute the candidate count — it's the "remaining" the front
  // end uses to keep stepping through batches and to render the
  // overall progress bar.
  const remaining = await prisma.book.count({ where });
  return { processed: candidates.length, updated, remaining, results };
}
