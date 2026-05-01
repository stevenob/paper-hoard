import { request } from "undici";
import { logger } from "./logger.js";

const MIN_COVER_BYTES = 8000;

/**
 * Verify that a cover URL responds with what looks like a real image,
 * not Google Books' "image not available" placeholder JPEG (~3 KB) or
 * Open Library's blank 1x1 gif.
 *
 * Strategy: HEAD request, check Content-Length. Real ISBN covers at
 * zoom=2 / OL -L.jpg run 30-150 KB; placeholders are ~3-5 KB. We treat
 * <8 KB as broken. Network errors are also treated as broken so callers
 * can fall through to the next source.
 *
 * Returns the URL when it's good, null when it's broken/missing.
 */
export async function validateCoverUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await request(url, {
      method: "HEAD",
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      // Some servers redirect HEAD requests. Follow one hop manually
      // since undici's request() doesn't auto-follow.
      const loc = res.headers["location"];
      const next = Array.isArray(loc) ? loc[0] : loc;
      if (next) {
        const followed = await request(new URL(next, url).toString(), {
          method: "HEAD",
          headersTimeout: 5000,
          bodyTimeout: 5000,
        });
        if (followed.statusCode >= 400) return null;
        const fcl = followed.headers["content-length"];
        const fclStr = Array.isArray(fcl) ? fcl[0] : fcl;
        const fbytes = fclStr ? Number(fclStr) : NaN;
        if (Number.isFinite(fbytes) && fbytes > 0 && fbytes < MIN_COVER_BYTES) return null;
        return url;
      }
      return null;
    }
    if (res.statusCode >= 400) return null;
    const raw = res.headers["content-length"];
    const cl = Array.isArray(raw) ? raw[0] : raw;
    const bytes = cl ? Number(cl) : NaN;
    if (Number.isFinite(bytes) && bytes > 0 && bytes < MIN_COVER_BYTES) {
      return null;
    }
    // No Content-Length header → trust the URL but log so we can spot
    // cases where validation is being skipped silently.
    if (!Number.isFinite(bytes)) {
      logger.debug({ url }, "cover URL has no Content-Length; accepted without size check");
    }
    return url;
  } catch (err) {
    logger.debug({ err, url }, "cover URL validation HEAD failed");
    return null;
  }
}

/**
 * Try a series of cover URLs in order, returning the first one that passes
 * validation. Used by the refresh-low-res-covers backfill to walk through
 * Google Books → Open Library -L.jpg → -M.jpg before giving up.
 *
 * Each candidate URL is validated with one HEAD round-trip. The function
 * short-circuits as soon as a valid URL is found.
 */
export async function pickValidCover(...candidates: Array<string | null | undefined>): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ok = await validateCoverUrl(candidate);
    if (ok) return ok;
  }
  return null;
}

/**
 * Construct an Open Library cover URL by ISBN. `?default=false` makes the
 * server return HTTP 404 for missing covers instead of a 1x1 blank gif —
 * critical so validateCoverUrl can detect them via status code.
 */
export function olCoverUrlByIsbn(isbn13: string, size: "S" | "M" | "L" = "L"): string {
  return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn13)}-${size}.jpg?default=false`;
}

/**
 * Construct a LibraryThing covers URL by ISBN. Requires LIBRARYTHING_DEVKEY
 * (free at https://www.librarything.com/services/keys.php). Returns null
 * when no key is configured so callers can cleanly skip this source.
 *
 * LibraryThing has surprisingly good coverage for niche / kids' / licensed
 * tie-in books that Google Books and Open Library miss — adding it as a
 * 3rd cascading source rescues a chunk of the "no source has it" pile.
 */
export function ltCoverUrlByIsbn(
  isbn13: string,
  size: "small" | "medium" | "large" = "large"
): string | null {
  const key = (process.env.LIBRARYTHING_DEVKEY ?? "").trim();
  if (!key) return null;
  return `https://covers.librarything.com/devkey/${encodeURIComponent(key)}/${size}/isbn/${encodeURIComponent(isbn13)}`;
}
