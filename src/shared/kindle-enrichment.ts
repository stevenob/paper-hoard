/**
 * Kindle ASIN enrichment — async-after-response.
 *
 * Hooks into routes that durably write to a Book (scan-confirm,
 * completion-create, CSV-import row, book edit/refetch). When the
 * HTTP response has finished flushing, we run a best-effort Open
 * Library lookup to populate `Book.kindleAsin` for books that
 * don't have one.
 *
 * Critical Node.js semantics: a bare `setImmediate(fn)` does NOT
 * guarantee post-response execution under Node 22 + Fastify — it
 * just defers to a later event-loop phase, while the surrounding
 * async route handler may still be doing awaited work. We hook
 * `reply.raw.once("finish", …)` instead so the enrichment provably
 * runs after the response is written. Routes that don't have a
 * reply (background jobs, future cron) fall back to setImmediate.
 *
 * Concurrency: an atomic claim via `prisma.book.updateMany` plus a
 * 7-day cooldown column ensures only one enricher per book per
 * cooldown window proceeds. Two parallel calls for the same book
 * naturally serialize — the second sees `count === 0` and exits
 * before any HTTP request.
 *
 * Burst control: a CSV import that touches hundreds of books would
 * otherwise schedule hundreds of `finish`-time enrichments that all
 * fire simultaneously and burst Open Library. We funnel everything
 * through a single in-process queue with a tiny per-job delay so
 * the OL load stays gentle even under bulk imports. The queue is
 * naturally bounded by the cooldown column — a re-imported CSV
 * doesn't re-queue.
 *
 * Manual user-curated ASINs (`kindleAsinSource = "manual"`) are
 * never touched by this module. The atomic claim's WHERE clause
 * excludes them outright.
 */

import type { FastifyReply } from "fastify";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { audit } from "./audit.js";
import { lookupKindleAsinFromOpenLibrary } from "./kindle.js";

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const QUEUE_DELAY_MS = 250; // be polite to Open Library between jobs

const queue: string[] = [];
let draining = false;

function enqueue(bookId: string): void {
  queue.push(bookId);
  if (!draining) {
    draining = true;
    setImmediate(drain);
  }
}

async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await enrichKindleAsin(next);
      } catch (err) {
        logger.warn({ err, bookId: next }, "kindle ASIN enrichment failed");
      }
      if (queue.length > 0) {
        await new Promise((r) => setTimeout(r, QUEUE_DELAY_MS));
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Schedule an enrichment to run after the HTTP response finishes.
 * Falls back to setImmediate when called outside a route context
 * (background tasks, tests with mocked replies, etc.).
 *
 * Always returns synchronously and never throws. Errors inside the
 * enrichment are logged and swallowed — callers must not depend on
 * the outcome.
 */
export function scheduleKindleAsinEnrichment(
  reply: FastifyReply | null | undefined,
  bookId: string
): void {
  const fire = () => enqueue(bookId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (reply as any)?.raw as
    | { writableEnded?: boolean; once?: (event: string, cb: () => void) => void }
    | undefined;
  if (raw && typeof raw.once === "function") {
    if (raw.writableEnded) {
      // Already finished (rare but possible if the route handler
      // did its work after reply.send()). Run on the next tick.
      setImmediate(fire);
    } else {
      raw.once("finish", fire);
    }
    return;
  }
  setImmediate(fire);
}

/**
 * Try to populate `Book.kindleAsin` from Open Library if it's
 * missing or out-of-date. Idempotent and safe to call repeatedly —
 * the atomic claim plus cooldown column protect against duplicates.
 *
 * Exported for tests; production code should always go through
 * `scheduleKindleAsinEnrichment`.
 */
export async function enrichKindleAsin(bookId: string): Promise<void> {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS);

  // Atomic claim: only one caller per cooldown window can pass.
  // Excludes:
  //  - books without an ISBN-13 (can't query OL)
  //  - books whose ASIN was manually set (kindleAsinSource = "manual")
  //  - books in the cooldown window (recent attempt)
  const claim = await prisma.book.updateMany({
    where: {
      id: bookId,
      isbn13: { not: null },
      AND: [
        {
          OR: [
            { kindleAsinSource: { not: "manual" } },
            { kindleAsinSource: null },
          ],
        },
        {
          OR: [
            { kindleAsinAttemptedAt: null },
            { kindleAsinAttemptedAt: { lt: cooldownCutoff } },
          ],
        },
      ],
    },
    data: { kindleAsinAttemptedAt: new Date() },
  });
  if (claim.count === 0) return;

  // Re-read after the claim so we work with the current row.
  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { id: true, isbn13: true, kindleAsin: true },
  });
  if (!book?.isbn13) return;

  const result = await lookupKindleAsinFromOpenLibrary(book.isbn13);
  if (!result) return;
  if (result === book.kindleAsin) {
    // Same value as before — no functional change, no audit noise.
    // The cooldown stamp from the claim is sufficient bookkeeping.
    return;
  }

  await prisma.book.update({
    where: { id: bookId },
    data: { kindleAsin: result, kindleAsinSource: "open_library" },
  });
  await audit({
    action: "update",
    entity: "book",
    entityId: bookId,
    details: { kindleAsin: result, kindleAsinSource: "open_library" },
  });
}
