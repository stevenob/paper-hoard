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
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    imageLinks?: { thumbnail?: string };
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
    thumbnailUrl: v.volumeInfo.imageLinks?.thumbnail,
    source: "google_books",
  };
}

async function lookupOpenLibraryByIsbn(isbn: string): Promise<BookMetadata | null> {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(
    isbn
  )}&format=json&jscmd=data`;
  const { statusCode, body } = await request(url);
  if (statusCode >= 400) return null;
  const json = (await body.json()) as Record<string, OpenLibraryBook>;
  const entry = json[`ISBN:${isbn}`];
  if (!entry) return null;
  return {
    isbn13: isbn.length === 13 ? isbn : undefined,
    isbn10: isbn.length === 10 ? isbn : undefined,
    title: entry.title ?? "Unknown Title",
    authors: (entry.authors ?? []).map((a) => a.name),
    publisher: entry.publishers?.[0]?.name,
    publishedAt: entry.publish_date,
    thumbnailUrl: entry.cover?.medium ?? entry.cover?.small,
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

export async function searchByTitle(query: string): Promise<BookMetadata[]> {
  try {
    return await lookupGoogleBooks(query, false);
  } catch (err) {
    logger.warn({ err }, "Google Books title search error");
    return [];
  }
}
