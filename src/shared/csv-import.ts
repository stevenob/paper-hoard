import Papa from "papaparse";

export interface ImportRow {
  isbn?: string;
  title?: string;
  author?: string;
  // Per-completion only:
  mediaType?: "ebook" | "audiobook";
  source?: string;
  completedOn?: Date;
  rating?: number;
  notes?: string;
  // Per-physical-copy only:
  condition?: string;
  edition?: string;
  location?: string;
}

export interface ParseResult {
  rows: ImportRow[];
  warnings: string[];
}

export type CsvFormat = "generic" | "goodreads" | "storygraph";
export type ImportType = "physical" | "completion";

function pickHeader(headers: string[], candidates: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

function clean(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!t) return undefined;
  // Goodreads wraps ISBNs as ="9780..." — strip the equals/quotes wrapper.
  return t.replace(/^="?|"?$/g, "");
}

export function parseCsv(
  csv: string,
  format: CsvFormat,
  type: ImportType
): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = parsed.meta.fields ?? [];
  const warnings: string[] = parsed.errors.map((e) => `row ${e.row ?? "?"}: ${e.message}`);

  if (format === "generic") {
    return {
      warnings,
      rows: parsed.data.map((r) => genericRow(r, type)),
    };
  }
  if (format === "goodreads") {
    return parseGoodreads(parsed.data, headers, type, warnings);
  }
  if (format === "storygraph") {
    return parseStoryGraph(parsed.data, headers, type, warnings);
  }
  return { rows: [], warnings: [`unknown format: ${format}`] };
}

function genericRow(r: Record<string, string>, type: ImportType): ImportRow {
  const isbn = clean(r.isbn || r.isbn13 || r.ISBN || r.ISBN13);
  const base: ImportRow = {
    isbn,
    title: clean(r.title || r.Title),
    author: clean(r.author || r.Author),
    notes: clean(r.notes || r.Notes),
  };
  if (type === "physical") {
    base.condition = clean(r.condition || r.Condition);
    base.edition = clean(r.edition || r.Edition);
    base.location = clean(r.location || r.Location);
  } else {
    const media = clean(r.mediaType || r.media_type)?.toLowerCase();
    base.mediaType = media === "audiobook" ? "audiobook" : "ebook";
    base.source = clean(r.source || r.Source);
    const dateStr = clean(r.completedOn || r.completed_on || r.date || r.Date);
    base.completedOn = dateStr ? safeDate(dateStr) : undefined;
    const ratingStr = clean(r.rating || r.Rating);
    base.rating = ratingStr ? parseRating(ratingStr) : undefined;
  }
  return base;
}

// ---- Goodreads ----
// https://www.goodreads.com/review/import — columns include:
// Title, Author, ISBN, ISBN13, My Rating, Date Read, Exclusive Shelf, Bookshelves
function parseGoodreads(
  data: Record<string, string>[],
  headers: string[],
  type: ImportType,
  warnings: string[]
): ParseResult {
  const titleH = pickHeader(headers, ["Title"]);
  const authorH = pickHeader(headers, ["Author"]);
  const isbnH = pickHeader(headers, ["ISBN13", "ISBN"]);
  const ratingH = pickHeader(headers, ["My Rating"]);
  const dateReadH = pickHeader(headers, ["Date Read"]);
  const shelfH = pickHeader(headers, ["Exclusive Shelf", "Bookshelves"]);

  const rows: ImportRow[] = [];
  for (const r of data) {
    const shelf = shelfH ? clean(r[shelfH])?.toLowerCase() : undefined;
    if (type === "completion" && shelf && shelf !== "read") continue;
    rows.push({
      isbn: isbnH ? clean(r[isbnH]) : undefined,
      title: titleH ? clean(r[titleH]) : undefined,
      author: authorH ? clean(r[authorH]) : undefined,
      mediaType: type === "completion" ? "ebook" : undefined,
      source: type === "completion" ? "goodreads" : undefined,
      completedOn:
        type === "completion" && dateReadH ? safeDate(clean(r[dateReadH])) : undefined,
      rating: type === "completion" && ratingH ? parseRating(clean(r[ratingH])) : undefined,
    });
  }
  return { rows, warnings };
}

// ---- StoryGraph ----
// Columns: Title, Authors, ISBN/UID, Format, Read Status, Last Date Read, Star Rating, Review
function parseStoryGraph(
  data: Record<string, string>[],
  headers: string[],
  type: ImportType,
  warnings: string[]
): ParseResult {
  const titleH = pickHeader(headers, ["Title"]);
  const authorH = pickHeader(headers, ["Authors", "Author"]);
  const isbnH = pickHeader(headers, ["ISBN/UID", "ISBN"]);
  const ratingH = pickHeader(headers, ["Star Rating"]);
  const dateH = pickHeader(headers, ["Last Date Read", "Dates Read", "Date Added"]);
  const statusH = pickHeader(headers, ["Read Status"]);
  const formatH = pickHeader(headers, ["Format"]);
  const reviewH = pickHeader(headers, ["Review"]);

  const rows: ImportRow[] = [];
  for (const r of data) {
    const status = statusH ? clean(r[statusH])?.toLowerCase() : undefined;
    if (type === "completion" && status && status !== "read") continue;
    const fmt = formatH ? clean(r[formatH])?.toLowerCase() : undefined;
    rows.push({
      isbn: isbnH ? clean(r[isbnH]) : undefined,
      title: titleH ? clean(r[titleH]) : undefined,
      author: authorH ? clean(r[authorH]) : undefined,
      mediaType: type === "completion" ? (fmt === "audio" ? "audiobook" : "ebook") : undefined,
      source: type === "completion" ? "storygraph" : undefined,
      completedOn:
        type === "completion" && dateH ? safeDate(clean(r[dateH])) : undefined,
      rating: type === "completion" && ratingH ? parseRating(clean(r[ratingH])) : undefined,
      notes: type === "completion" && reviewH ? clean(r[reviewH]) : undefined,
    });
  }
  return { rows, warnings };
}

function safeDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseRating(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  if (isNaN(n) || n <= 0) return undefined;
  return Math.min(5, Math.max(1, Math.round(n)));
}
