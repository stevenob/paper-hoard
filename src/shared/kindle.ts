/**
 * Kindle link-out helpers.
 *
 * Paper Hoard exposes a "📖 Read on Kindle" button on owned books and
 * a small badge on library list rows when a Book has a `kindleAsin`.
 * The link points at Amazon's Cloud Reader, which gracefully falls
 * back to the product page for unauthenticated visitors. We never
 * host ebook files — see docs/v1-scope.md.
 *
 * Hosting Amazon-purchased Kindle files would require breaking their
 * DRM (DMCA / ToS issue), so we link-out instead. DRM-free EPUBs are
 * a separate possible feature; not in scope here.
 */

import { request } from "undici";
import { logger } from "./logger.js";

const ASIN_RE = /^[A-Z0-9]{10}$/;
const KINDLE_ASIN_RE = /^B0[A-Z0-9]{8}$/;

/**
 * Trim, uppercase, validate. Returns the canonicalised ASIN or null
 * if the input doesn't match `/^[A-Z0-9]{10}$/`. The single chokepoint
 * for accepting user input — every route that persists an ASIN should
 * pass through this.
 *
 * NOTE: a value like "0593135202" passes (it's the right shape, even
 * though it's actually an ISBN-10). The UI surfaces a "looks like an
 * ISBN-10" hint via `looksLikeKindleAsin` for those cases. We allow
 * them because some print editions DO use ISBN-10 as their ASIN, and
 * blocking would be over-paternalistic.
 */
export function normalizeAsin(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase();
  if (!ASIN_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * True iff the ASIN matches the Kindle-ebook shape `/^B0[A-Z0-9]{8}$/`.
 * Used to decide whether to surface the "Looks like an ISBN-10. Kindle
 * ebooks start with B0…" hint, and as the filter for OL search results.
 *
 * Tighter than `startsWith("B")` — there are non-ebook B-prefix ASINs
 * for other Amazon products. The Kindle ebook prefix is specifically B0.
 */
export function looksLikeKindleAsin(asin: string): boolean {
  return KINDLE_ASIN_RE.test(asin);
}

/**
 * Build the Cloud Reader URL for an ASIN.
 *
 * `https://read.amazon.com/kp/kshare?asin=<ASIN>` opens the book in
 * the browser-based Kindle Cloud Reader for an authenticated owner.
 * For unauthenticated visitors (or users who don't own the book), it
 * 302-redirects to the Amazon product page — verified at plan time
 * with curl. Acceptable graceful fallback.
 *
 * Callers must render the link with
 *   target="_blank" rel="noopener noreferrer"
 *   referrerpolicy="no-referrer"
 * so paper-hoard's hostname is not leaked to Amazon via Referer.
 */
export function readOnKindleUrl(asin: string): string {
  return `https://read.amazon.com/kp/kshare?asin=${encodeURIComponent(asin)}`;
}

interface OpenLibrarySearchDoc {
  isbn?: string[];
  id_amazon?: string[];
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibrarySearchDoc[];
}

/**
 * Look up the Kindle ASIN for a known ISBN-13 via Open Library's
 * search endpoint. Verified at plan time that ASINs live on the
 * search response's `id_amazon` field, NOT on the per-edition
 * `/isbn/<isbn>.json` endpoint that paper-hoard already calls
 * elsewhere — that's why this helper exists separately.
 *
 * Defenses against false matches:
 *  - We request `isbn` AND `id_amazon` and reject any doc whose
 *    `isbn` array does NOT contain our queried value. OL's search
 *    is tolerant and can return loosely-related works for
 *    partial/typo'd queries; ISBN containment is the cheap
 *    sanity check that keeps us from poisoning a Book row with
 *    an unrelated edition's ASIN.
 *  - The `id_amazon` array can mix ISBN-10s and Kindle ASINs in
 *    any order — verified with Project Hail Mary returning
 *    `["855651121X", "B08GB58KD5", "B08FHBV4ZX"]`. We filter to
 *    `/^B0[A-Z0-9]{8}$/` and take the first.
 *
 * Returns undefined on timeout, network error, no ISBN-verified
 * doc, or no B0-prefixed value. Never throws — failures are
 * logged at warn level and otherwise swallowed because callers
 * are best-effort enrichment sites.
 */
export async function lookupKindleAsinFromOpenLibrary(
  isbn13: string
): Promise<string | undefined> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(
    isbn13
  )}&fields=key,isbn,id_amazon&limit=5`;
  let json: OpenLibrarySearchResponse;
  try {
    const { statusCode, body } = await request(url, {
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });
    if (statusCode >= 400) return undefined;
    json = (await body.json()) as OpenLibrarySearchResponse;
  } catch (err) {
    logger.warn({ err, isbn13 }, "Open Library ASIN lookup failed");
    return undefined;
  }
  const docs = json.docs ?? [];
  for (const doc of docs) {
    if (!doc.isbn?.includes(isbn13)) continue;
    const candidates = doc.id_amazon ?? [];
    for (const candidate of candidates) {
      const upper = candidate.toUpperCase();
      if (KINDLE_ASIN_RE.test(upper)) return upper;
    }
    // First ISBN-verified doc wins, even if it has no B0 ASIN. The
    // alternative (continuing to scan more docs) risks picking up
    // an ASIN from a *different* edition record. Better to return
    // nothing than to attach the wrong ASIN.
    return undefined;
  }
  return undefined;
}
