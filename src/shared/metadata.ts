import { request } from "undici";
import { env } from "./env.js";
import { logger } from "./logger.js";

export interface BookMetadata {
  isbn13?: string;
  isbn10?: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
  edition?: string; // mapped to our picklist when sources expose physical_format
  source: "google_books" | "open_library" | "manual";
}

function normalizeIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, "").toUpperCase();
}

async function lookupGoogleBooks(query: string, byIsbn: boolean): Promise<BookMetadata[]> {
  const q = byIsbn ? `isbn:${query}` : query;
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "5");
  if (env.GOOGLE_BOOKS_API_KEY) url.searchParams.set("key", env.GOOGLE_BOOKS_API_KEY);

  const { statusCode, body } = await request(url.toString());
  if (statusCode === 429) {
    logger.warn(
      "Google Books returned 429 — anonymous quota exceeded; set GOOGLE_BOOKS_API_KEY for higher limits"
    );
    return [];
  }
  if (statusCode >= 400) {
    logger.warn({ statusCode }, "Google Books request failed");
    return [];
  }
  const json = (await body.json()) as { items?: GoogleVolume[] };
  return (json.items ?? []).map(volumeToMetadata);
}

interface GoogleVolume {
  volumeInfo: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string };
    seriesInfo?: {
      bookDisplayNumber?: string;
      volumeSeries?: { seriesId?: string }[];
    };
  };
}

function volumeToMetadata(v: GoogleVolume): BookMetadata {
  const ids = v.volumeInfo.industryIdentifiers ?? [];
  const isbn13 = ids.find((i) => i.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((i) => i.type === "ISBN_10")?.identifier;
  return {
    isbn13: isbn13 ? normalizeIsbn(isbn13) : undefined,
    isbn10: isbn10 ? normalizeIsbn(isbn10) : undefined,
    title: v.volumeInfo.title ?? "Unknown Title",
    authors: v.volumeInfo.authors ?? [],
    publisher: v.volumeInfo.publisher,
    publishedAt: v.volumeInfo.publishedDate,
    thumbnailUrl: upgradeGoogleBooksImageUrl(v.volumeInfo.imageLinks?.thumbnail),
    source: "google_books",
  };
}

/**
 * Google Books returns thumbnails at ~128px width by default and over
 * plain HTTP. We upgrade to https + a larger zoom value, but specifically
 * NOT zoom=0 — that returns Google's "image not available" placeholder
 * for books where they don't store a hi-res copy (small publishers,
 * older titles, etc). zoom=2 reliably returns a ~256px real image for
 * any book that has any cover at all.
 */
function upgradeGoogleBooksImageUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url = raw.replace(/^http:\/\//, "https://");
  url = url.replace(/([?&])zoom=\d+/g, "$1zoom=2");
  url = url.replace(/[?&]edge=curl/g, "");
  return url;
}

async function fetchOpenLibraryEdition(isbn: string): Promise<OpenLibraryEdition | null> {
  // /isbn/<isbn>.json 302-redirects to /books/<editionKey>.json. undici doesn't
  // follow redirects by default at the request() level, so do it manually.
  try {
    const initial = await request(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
    if (initial.statusCode >= 300 && initial.statusCode < 400) {
      const loc = initial.headers["location"];
      const next = Array.isArray(loc) ? loc[0] : loc;
      if (next) {
        const followed = await request(new URL(next, "https://openlibrary.org").toString());
        if (followed.statusCode < 400) return (await followed.body.json()) as OpenLibraryEdition;
      }
      return null;
    }
    if (initial.statusCode < 400) return (await initial.body.json()) as OpenLibraryEdition;
  } catch {
    /* ignore */
  }
  return null;
}

async function lookupOpenLibraryByIsbn(isbn: string): Promise<BookMetadata | null> {
  // Use the richer /isbn/<isbn>.json endpoint so we can read physical_format
  // (binding) and the work key for series + ratings later. Falls back to the
  // older /api/books endpoint for the cover thumbnail.
  const detail = await fetchOpenLibraryEdition(isbn);

  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(
    isbn
  )}&format=json&jscmd=data`;
  const { statusCode, body } = await request(url);
  if (statusCode >= 400 && !detail) return null;
  let entry: OpenLibraryBook | undefined;
  if (statusCode < 400) {
    const json = (await body.json()) as Record<string, OpenLibraryBook>;
    entry = json[`ISBN:${isbn}`];
  }
  if (!entry && !detail) return null;

  return {
    isbn13: isbn.length === 13 ? isbn : undefined,
    isbn10: isbn.length === 10 ? isbn : undefined,
    title: entry?.title ?? detail?.title ?? "Unknown Title",
    authors: (entry?.authors ?? []).map((a) => a.name),
    publisher: entry?.publishers?.[0]?.name ?? detail?.publishers?.[0],
    publishedAt: entry?.publish_date ?? detail?.publish_date,
    thumbnailUrl: entry?.cover?.large ?? entry?.cover?.medium ?? entry?.cover?.small,
    edition: mapPhysicalFormat(detail?.physical_format),
    source: "open_library",
  };
}

interface OpenLibraryBook {
  title?: string;
  authors?: { name: string }[];
  publishers?: { name: string }[];
  publish_date?: string;
  cover?: { small?: string; medium?: string; large?: string };
}

interface OpenLibraryEdition {
  title?: string;
  publishers?: string[];
  publish_date?: string;
  physical_format?: string;
}

function mapPhysicalFormat(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase().trim();
  if (s.includes("mass market") || s.includes("mass-market")) return "mass-market";
  if (s.includes("hardcover") || s.includes("hard cover") || s === "hard back" || s.includes("hardback")) return "hardcover";
  if (s.includes("paperback") || s.includes("trade paper") || s === "soft back" || s.includes("softback")) return "paperback";
  if (s.includes("box set") || s.includes("boxed set") || s.includes("boxset") || s.includes("box-set")) return "boxset";
  if (s.includes("signed") || s.includes("special")) return "special";
  return undefined;
}

export async function lookupByIsbn(rawIsbn: string): Promise<BookMetadata | null> {
  const isbn = normalizeIsbn(rawIsbn);
  if (isbn.length !== 10 && isbn.length !== 13) return null;
  try {
    const google = await lookupGoogleBooks(isbn, true);
    if (google.length > 0) return google[0];
  } catch (err) {
    logger.warn({ err }, "Google Books lookup error");
  }
  try {
    return await lookupOpenLibraryByIsbn(isbn);
  } catch (err) {
    logger.warn({ err }, "Open Library lookup error");
    return null;
  }
}

async function searchOpenLibraryByTitle(query: string): Promise<BookMetadata[]> {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", "title,author_name,isbn,cover_i,publisher,first_publish_year");
  const { statusCode, body } = await request(url.toString());
  if (statusCode >= 400) {
    logger.warn({ statusCode }, "Open Library search failed");
    return [];
  }
  const json = (await body.json()) as { docs?: OpenLibrarySearchDoc[] };
  return (json.docs ?? []).map(searchDocToMetadata);
}

interface OpenLibrarySearchDoc {
  title?: string;
  author_name?: string[];
  isbn?: string[];
  cover_i?: number;
  publisher?: string[];
  first_publish_year?: number;
}

function searchDocToMetadata(d: OpenLibrarySearchDoc): BookMetadata {
  const isbns = d.isbn ?? [];
  const isbn13 = isbns.find((s) => s.length === 13);
  const isbn10 = isbns.find((s) => s.length === 10);
  return {
    isbn13,
    isbn10,
    title: d.title ?? "Unknown Title",
    authors: d.author_name ?? [],
    publisher: d.publisher?.[0],
    publishedAt: d.first_publish_year ? String(d.first_publish_year) : undefined,
    thumbnailUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
    source: "open_library",
  };
}

export async function searchByTitle(query: string): Promise<BookMetadata[]> {
  let results: BookMetadata[] = [];
  try {
    results = await lookupGoogleBooks(query, false);
  } catch (err) {
    logger.warn({ err }, "Google Books title search error");
  }
  if (results.length > 0) return results;
  try {
    return await searchOpenLibraryByTitle(query);
  } catch (err) {
    logger.warn({ err }, "Open Library title search error");
    return [];
  }
}

/**
 * LibraryThing thingISBN — given an ISBN, returns ISBNs of OTHER editions
 * of the same work (different reprints, translations, paperback/hardcover
 * pairings). Used as a third-tier cover-rescue when Google Books and
 * Open Library both fail for the user's specific edition: the cover for
 * a sister edition is usually the same anyway.
 *
 * The endpoint returns XML like:
 *   <idlist>
 *     <isbn>9780553293357</isbn>
 *     <isbn>0345253426</isbn>
 *     ...
 *   </idlist>
 *
 * Requires a free dev token from
 *   https://www.librarything.com/services/keys.php
 * stored in LIBRARYTHING_DEVKEY. Returns [] when no key is configured or
 * the request fails — callers should treat as "no sister editions found"
 * and fall through to the next strategy.
 */
export async function thingIsbn(rawIsbn: string): Promise<string[]> {
  const isbn = normalizeIsbn(rawIsbn);
  if (isbn.length !== 10 && isbn.length !== 13) return [];
  const token = (env.LIBRARYTHING_DEVKEY ?? "").trim();
  if (!token) return [];
  const url = `https://www.librarything.com/api/${encodeURIComponent(token)}/thingISBN/${encodeURIComponent(isbn)}`;
  try {
    const { statusCode, body } = await request(url, { headersTimeout: 5000, bodyTimeout: 5000 });
    if (statusCode >= 400) {
      logger.debug({ statusCode, isbn }, "thingISBN request failed");
      return [];
    }
    const xml = await body.text();
    // Cheap XML scrape — pulling <isbn>...</isbn> contents avoids a
    // dependency on a full parser. The response is a flat list, so the
    // regex is enough.
    const matches = Array.from(xml.matchAll(/<isbn>([^<]+)<\/isbn>/g));
    const results = matches
      .map((m) => normalizeIsbn(m[1]))
      .filter((s) => s !== isbn && (s.length === 10 || s.length === 13));
    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const r of results) {
      if (!seen.has(r)) {
        seen.add(r);
        ordered.push(r);
      }
    }
    return ordered;
  } catch (err) {
    logger.debug({ err, isbn }, "thingISBN request error");
    return [];
  }
}

/**
 * Open Library series search. There's no direct "books in this series"
 * API, but the search endpoint accepts `series:"<name>"` as a query
 * filter. Returns up to 50 entries; we dedupe by title and filter the
 * obvious noise (audio editions, omnibuses) before showing on the
 * series detail page.
 */
export interface SeriesEntry {
  title: string;
  authors: string[];
  isbn13?: string;
  isbn10?: string;
  thumbnailUrl?: string;
  publishedYear?: number;
  /** Position in the series, parsed from OL's free-text "series" field. */
  position?: number;
  /** OL Work key for linking to the OL page (e.g. "/works/OL12345W"). */
  olWorkId?: string;
}

interface OLSeriesSearchDoc {
  title?: string;
  author_name?: string[];
  isbn?: string[];
  cover_i?: number;
  first_publish_year?: number;
  series?: string[]; // e.g. ["Mistborn, #1", "Mistborn, Book 1"]
  key?: string; // "/works/OL12345W"
}

export async function searchOpenLibrarySeries(seriesName: string): Promise<SeriesEntry[]> {
  const trimmed = seriesName.trim();
  if (trimmed.length < 2) return [];
  const url = new URL("https://openlibrary.org/search.json");
  // Quoted phrase + series field qualifier. OL ranks exact-phrase matches first.
  url.searchParams.set("q", `series:"${trimmed}"`);
  url.searchParams.set("limit", "50");
  url.searchParams.set(
    "fields",
    "title,author_name,isbn,cover_i,first_publish_year,series,key"
  );
  try {
    const { statusCode, body } = await request(url.toString(), {
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    if (statusCode >= 400) {
      logger.warn({ statusCode }, "OL series search failed");
      return [];
    }
    const json = (await body.json()) as { docs?: OLSeriesSearchDoc[] };
    const docs = json.docs ?? [];
    const target = trimmed.toLowerCase();
    const entries: SeriesEntry[] = [];
    for (const d of docs) {
      const title = (d.title ?? "").trim();
      if (!title) continue;
      // Sanity check: OL series search returns plenty of irrelevant work
      // when the qualifier isn't honored; skip docs whose `series` array
      // doesn't actually mention the requested series name.
      const seriesArr = d.series ?? [];
      const mentioned = seriesArr.some((s) => s.toLowerCase().includes(target));
      if (!mentioned) continue;
      // Heuristic noise filter: audiobook editions, study guides, etc.
      const lower = title.toLowerCase();
      if (
        lower.includes("audio") ||
        lower.includes("study guide") ||
        lower.includes("summary of") ||
        lower.includes("analysis of")
      ) {
        continue;
      }
      entries.push({
        title,
        authors: d.author_name ?? [],
        isbn13: d.isbn?.find((i) => i.length === 13),
        isbn10: d.isbn?.find((i) => i.length === 10),
        thumbnailUrl: d.cover_i
          ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`
          : undefined,
        publishedYear: d.first_publish_year,
        position: extractSeriesPosition(seriesArr, target),
        olWorkId: d.key ?? undefined,
      });
    }
    // Dedup by lowercased title (drops omnibuses with same title).
    const seen = new Set<string>();
    const deduped: SeriesEntry[] = [];
    for (const e of entries) {
      const key = e.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }
    return deduped;
  } catch (err) {
    logger.debug({ err, seriesName }, "OL series search error");
    return [];
  }
}

/**
 * Pull a numeric position out of OL's freeform series strings.
 * Examples: "Mistborn, #2" → 2, "Foundation; 3" → 3,
 *           "The Expanse, Book 4" → 4. Returns undefined if nothing
 *           plausible matches.
 */
function extractSeriesPosition(seriesArr: string[], targetLower: string): number | undefined {
  for (const s of seriesArr) {
    if (!s.toLowerCase().includes(targetLower)) continue;
    // Match "#3", "Book 3", "Vol. 3", "Part 3", or just a trailing number.
    const m = s.match(/(?:#|book\s+|vol\.?\s+|volume\s+|part\s+|,\s*)\s*(\d+(?:\.\d+)?)\s*$/i);
    if (m) return Number.parseFloat(m[1]);
  }
  return undefined;
}
