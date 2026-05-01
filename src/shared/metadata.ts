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
