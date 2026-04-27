import { request } from "undici";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface IsbnDetailsResponse {
  works?: { key: string }[];
}

interface RatingsResponse {
  summary?: { average?: number | null; count?: number | null };
}

async function fetchWorkIdFromIsbn(isbn: string): Promise<string | null> {
  try {
    const initial = await request(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`, {
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    let json: IsbnDetailsResponse;
    if (initial.statusCode >= 300 && initial.statusCode < 400) {
      const loc = initial.headers["location"];
      const next = Array.isArray(loc) ? loc[0] : loc;
      if (!next) return null;
      const followed = await request(new URL(next, "https://openlibrary.org").toString(), {
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      if (followed.statusCode >= 400) return null;
      json = (await followed.body.json()) as IsbnDetailsResponse;
    } else if (initial.statusCode >= 400) {
      return null;
    } else {
      json = (await initial.body.json()) as IsbnDetailsResponse;
    }
    const key = json.works?.[0]?.key; // "/works/OL12345W"
    if (!key) return null;
    return key.replace(/^\/works\//, "");
  } catch (err) {
    logger.warn({ err, isbn }, "OL isbn lookup failed");
    return null;
  }
}

async function fetchRatings(workId: string): Promise<{ avg: number | null; count: number | null }> {
  try {
    const res = await request(
      `https://openlibrary.org/works/${encodeURIComponent(workId)}/ratings.json`,
      { headersTimeout: 5_000, bodyTimeout: 5_000 }
    );
    if (res.statusCode >= 400) return { avg: null, count: null };
    const json = (await res.body.json()) as RatingsResponse;
    return {
      avg: json.summary?.average ?? null,
      count: json.summary?.count ?? null,
    };
  } catch (err) {
    logger.warn({ err, workId }, "OL ratings fetch failed");
    return { avg: null, count: null };
  }
}

/**
 * Refreshes Open Library rating fields on a Book row. Best-effort — never
 * throws and never blocks the calling request for more than ~5s per HTTP
 * call (10s worst case). Designed to be invoked in fire-and-forget mode
 * from the book detail page when the cached value is missing or stale.
 */
export async function refreshOpenLibraryRatings(bookId: string): Promise<void> {
  try {
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    if (!book?.isbn13) return;
    let workId = book.olWorkId;
    if (!workId) {
      workId = await fetchWorkIdFromIsbn(book.isbn13);
      if (!workId) {
        // Mark as fetched so we don't retry every render.
        await prisma.book.update({
          where: { id: bookId },
          data: { olFetchedAt: new Date() },
        });
        return;
      }
    }
    const { avg, count } = await fetchRatings(workId);
    await prisma.book.update({
      where: { id: bookId },
      data: {
        olWorkId: workId,
        olRatingAvg: avg,
        olRatingCount: count,
        olFetchedAt: new Date(),
      },
    });
    logger.debug({ bookId, workId, avg, count }, "OL ratings refreshed");
  } catch (err) {
    logger.warn({ err, bookId }, "refreshOpenLibraryRatings failed");
  }
}

export function isStale(fetchedAt: Date | null): boolean {
  if (!fetchedAt) return true;
  return Date.now() - fetchedAt.getTime() > STALE_AFTER_MS;
}
