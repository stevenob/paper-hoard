import { prisma } from "../../shared/db.js";
import { lookupByIsbn } from "../../shared/metadata.js";
import { logger } from "../../shared/logger.js";
import { olCoverUrlByIsbn, ltCoverUrlByIsbn, validateCoverUrl } from "../../shared/cover-validation.js";

export type RepairAction = "kept" | "repaired" | "nulled" | "failed";

export interface RepairResultRow {
  bookId: string;
  copyId: string | null;
  title: string;
  author: string | null;
  thumbnailUrl: string | null;
  action: RepairAction;
  detail: string;
}

export interface BackfillResult {
  processed: number;
  updated: number;
  remaining: number;
  results: RepairResultRow[];
}

export interface RepairScope {
  /** Restrict candidates to books with at least one non-deleted copy
   *  in this library. When null, accepts any book with a non-deleted
   *  copy in any library. Mirrors the filter used on /about so the
   *  in-panel progress total matches the displayed candidate count. */
  libraryId: string | null;
  /** When true, ignore the recently-attempted cooldown so previously-
   *  failed books are re-tested. Use after enabling a new metadata
   *  source (e.g. LIBRARYTHING_DEVKEY). */
  ignoreCooldown?: boolean;
}

function copyScopeFilter(scope: RepairScope) {
  return scope.libraryId
    ? { physicalCopies: { some: { libraryId: scope.libraryId, deletedAt: null } } }
    : { physicalCopies: { some: { deletedAt: null } } };
}

/**
 * Walk a list of candidate cover URLs, returning the first that validates
 * along with a human-friendly source label ("Google", "OL-L", "OL-M").
 * Mirrors pickValidCover but also reports which source won — needed for the
 * activity log so the user sees "Google → OL-L" rather than just a URL.
 */
async function pickValidCoverWithSource(
  candidates: Array<{ url: string | null | undefined; source: string }>
): Promise<{ url: string; source: string } | null> {
  for (const c of candidates) {
    if (!c.url) continue;
    const ok = await validateCoverUrl(c.url);
    if (ok) return { url: ok, source: c.source };
  }
  return null;
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
/**
 * Skip-recently-attempted window. Books whose lookup failed in the last
 * N days won't be retried — keeps the candidate pool from cycling the
 * same unfetchable ISBNs forever. Worth retrying every so often in case
 * Google or Open Library finally indexes them.
 */
const RETRY_AFTER_DAYS = 30;
function recentlyAttemptedCutoff(): Date {
  return new Date(Date.now() - RETRY_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

export async function refetchMissingCovers(batchSize: number, scope: RepairScope): Promise<BackfillResult> {
  const cutoff = recentlyAttemptedCutoff();
  const where = {
    thumbnailUrl: null,
    isbn13: { not: null },
    ...(scope.ignoreCooldown
      ? {}
      : { OR: [{ coverAttemptedAt: null }, { coverAttemptedAt: { lt: cutoff } }] }),
    ...copyScopeFilter(scope),
  };
  const candidates = await prisma.book.findMany({
    where,
    select: {
      id: true,
      isbn13: true,
      title: true,
      primaryAuthor: true,
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
  for (const c of candidates) {
    const copyId = c.physicalCopies[0]?.id ?? null;
    if (!c.isbn13) {
      // Mark attempted so we don't keep landing on this book.
      await prisma.book.update({
        where: { id: c.id },
        data: { coverAttemptedAt: new Date() },
      });
      results.push({
        bookId: c.id,
        copyId,
        title: c.title,
        author: c.primaryAuthor,
        thumbnailUrl: null,
        action: "failed",
        detail: "no ISBN to look up",
      });
      continue;
    }
    try {
      const meta = await lookupByIsbn(c.isbn13);
      const picked = await pickValidCoverWithSource([
        { url: meta?.thumbnailUrl, source: "Google" },
        { url: olCoverUrlByIsbn(c.isbn13, "L"), source: "OL-L" },
        { url: olCoverUrlByIsbn(c.isbn13, "M"), source: "OL-M" },
        { url: ltCoverUrlByIsbn(c.isbn13, "large"), source: "LibraryThing" },
      ]);
      const validated = picked?.url ?? null;
      // Always stamp coverAttemptedAt so this book drops out of the
      // candidate pool until RETRY_AFTER_DAYS, even when no cover was
      // found — otherwise the pool cycles forever on books that no source
      // has a real image for.
      await prisma.book.update({
        where: { id: c.id },
        data: {
          thumbnailUrl: validated,
          coverAttemptedAt: new Date(),
          publisher: meta?.publisher ?? undefined,
          publishedAt: meta?.publishedAt ?? undefined,
        },
      });
      if (validated) updated++;
      results.push({
        bookId: c.id,
        copyId,
        title: c.title,
        author: c.primaryAuthor,
        thumbnailUrl: validated,
        action: validated ? "repaired" : "failed",
        detail: validated ? `found via ${picked!.source}` : "no source has it",
      });
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "cover backfill failed for book");
      // Network errors get a stamp too — otherwise an outage would re-stack
      // the entire pool back into "untried" state on next batch.
      await prisma.book
        .update({ where: { id: c.id }, data: { coverAttemptedAt: new Date() } })
        .catch(() => undefined);
      results.push({
        bookId: c.id,
        copyId,
        title: c.title,
        author: c.primaryAuthor,
        thumbnailUrl: null,
        action: "failed",
        detail: "lookup error",
      });
    }
  }

  const remaining = await prisma.book.count({ where });

  return { processed: candidates.length, updated, remaining, results };
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
 *
 * The criteria intentionally include any Google Books `zoom=` URL: we
 * can't tell from the URL alone whether it's a real cover or the "image
 * not available" placeholder, only the HEAD-size check in pickValidCover
 * can. Books with valid zoom=2 covers no-op cheaply (one HEAD request);
 * books with broken zoom=2 placeholders fall through to OL.
 */
export async function refreshLowResCovers(batchSize: number, scope: RepairScope): Promise<BackfillResult> {
  const lowResWhere = {
    isbn13: { not: null },
    thumbnailUrl: { not: null },
    source: { not: "manual" },
    OR: [
      { thumbnailUrl: { contains: "zoom=" } },
      { thumbnailUrl: { contains: "edge=curl" } },
      { thumbnailUrl: { contains: "-M.jpg" } },
      { thumbnailUrl: { contains: "-S.jpg" } },
      { thumbnailUrl: { startsWith: "http://" } },
    ],
    ...copyScopeFilter(scope),
  };

  const candidates = await prisma.book.findMany({
    where: lowResWhere as never,
    select: {
      id: true,
      isbn13: true,
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
  for (const c of candidates) {
    const copyId = c.physicalCopies[0]?.id ?? null;
    if (!c.isbn13) continue;
    try {
      // Step 1: refresh metadata. Picks up the v3.5.2 zoom=2 URL plus any
      // other recently-improved fields.
      const meta = await lookupByIsbn(c.isbn13);
      // Step 2: validate the candidate URLs in order. Tracks which source
      // produced the winning URL so the activity log can show "Google"
      // vs "OL-L" rather than just a URL diff.
      const picked = await pickValidCoverWithSource([
        { url: meta?.thumbnailUrl, source: "Google" },
        { url: olCoverUrlByIsbn(c.isbn13, "L"), source: "OL-L" },
        { url: olCoverUrlByIsbn(c.isbn13, "M"), source: "OL-M" },
        { url: ltCoverUrlByIsbn(c.isbn13, "large"), source: "LibraryThing" },
      ]);
      const validated = picked?.url ?? null;
      await prisma.book.update({
        where: { id: c.id },
        data: { thumbnailUrl: validated },
      });
      if (validated) updated++;
      // Action is "kept" only when the URL didn't change — same source,
      // same value. "repaired" covers both "swapped sources" and "Google
      // returned a fresh URL we hadn't seen before".
      let action: RepairAction;
      let detail: string;
      if (!validated) {
        action = "nulled";
        detail = "no source has it";
      } else if (validated === c.thumbnailUrl) {
        action = "kept";
        detail = `kept (${picked!.source})`;
      } else {
        action = "repaired";
        detail = `→ ${picked!.source}`;
      }
      results.push({
        bookId: c.id,
        copyId,
        title: c.title,
        author: c.primaryAuthor,
        thumbnailUrl: validated,
        action,
        detail,
      });
    } catch (err) {
      logger.warn({ err, bookId: c.id }, "cover refresh failed for book");
      results.push({
        bookId: c.id,
        copyId,
        title: c.title,
        author: c.primaryAuthor,
        thumbnailUrl: c.thumbnailUrl,
        action: "failed",
        detail: "lookup error",
      });
    }
  }

  const remaining = await prisma.book.count({ where: lowResWhere as never });

  return { processed: candidates.length, updated, remaining, results };
}
