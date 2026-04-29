import { prisma } from "../../shared/db.js";

/**
 * Build a one-row-per-active-copy CSV. Pure data export — every column is
 * what you'd want in Excel for an insurance inventory or a migration to
 * another tool. Shelf assignments are joined with `;` so the column stays
 * single-valued.
 */
export async function exportLibraryCsv(libraryId: string): Promise<string> {
  const copies = await prisma.physicalCopy.findMany({
    where: { libraryId, deletedAt: null },
    include: {
      book: true,
      addedBy: { select: { displayName: true } },
      shelves: { include: { shelf: { select: { name: true } } } },
    },
    orderBy: [{ book: { primaryAuthor: "asc" } }, { book: { title: "asc" } }],
  });

  const headers = [
    "title",
    "primaryAuthor",
    "authors",
    "isbn13",
    "isbn10",
    "publisher",
    "publishedAt",
    "edition",
    "condition",
    "shelves",
    "addedBy",
    "addedAt",
    "notes",
    "olRatingAvg",
    "olRatingCount",
    "source",
    "bookId",
    "copyId",
  ];

  const lines: string[] = [headers.join(",")];
  for (const c of copies) {
    const row = [
      c.book.title,
      c.book.primaryAuthor ?? "",
      c.book.authors.join("; "),
      c.book.isbn13 ?? "",
      c.book.isbn10 ?? "",
      c.book.publisher ?? "",
      c.book.publishedAt ?? "",
      c.edition ?? "",
      c.condition ?? "",
      c.shelves.map((sc) => sc.shelf.name).join("; "),
      c.addedBy.displayName,
      c.addedAt.toISOString(),
      c.notes ?? "",
      c.book.olRatingAvg ?? "",
      c.book.olRatingCount ?? "",
      c.book.source ?? "",
      c.book.id,
      c.id,
    ];
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function escapeCsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote any cell containing a comma, quote, or newline. Embedded
  // double-quotes get doubled per RFC 4180.
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Library-scoped JSON export. Includes everything needed to restore the
 * library to another instance: books referenced by this library's copies/
 * trophies/completions, copies, shelves, shelf assignments, and trophies.
 *
 * Excluded: User Discord IDs, library Discord guildId, library notify
 * channel, audit log, outbound notifications. The export is portable
 * enough to share without leaking identity or operational secrets.
 */
export async function exportLibraryJson(libraryId: string): Promise<unknown> {
  const [library, copies, shelves, trophies, completions] = await Promise.all([
    prisma.library.findUnique({
      where: { id: libraryId },
      select: { id: true, name: true, createdAt: true },
    }),
    prisma.physicalCopy.findMany({
      where: { libraryId, deletedAt: null },
      include: {
        book: true,
        addedBy: { select: { displayName: true } },
        shelves: { select: { shelfId: true, position: true } },
      },
    }),
    prisma.shelf.findMany({
      where: { libraryId },
      orderBy: { name: "asc" },
    }),
    prisma.trophy.findMany({
      where: { libraryId },
      include: {
        book: true,
        requestedBy: { select: { displayName: true } },
      },
    }),
    prisma.completion.findMany({
      where: { libraryId },
      include: {
        book: true,
        user: { select: { displayName: true } },
      },
    }),
  ]);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    library,
    copies: copies.map((c) => ({
      id: c.id,
      bookId: c.bookId,
      addedBy: c.addedBy.displayName,
      addedAt: c.addedAt.toISOString(),
      condition: c.condition,
      edition: c.edition,
      notes: c.notes,
      coverPath: c.coverPath,
      shelves: c.shelves,
      book: serializeBook(c.book),
    })),
    shelves: shelves.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      isOrdered: s.isOrdered,
    })),
    trophies: trophies.map((t) => ({
      id: t.id,
      bookId: t.bookId,
      requestedBy: t.requestedBy.displayName,
      desiredFormat: t.desiredFormat,
      priority: t.priority,
      reason: t.reason,
      createdAt: t.createdAt.toISOString(),
      book: serializeBook(t.book),
    })),
    completions: completions.map((c) => ({
      id: c.id,
      bookId: c.bookId,
      user: c.user.displayName,
      mediaType: c.mediaType,
      source: c.source,
      completedOn: c.completedOn?.toISOString() ?? null,
      rating: c.rating,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
      book: serializeBook(c.book),
    })),
  };
}

function serializeBook(b: {
  id: string;
  title: string;
  authors: string[];
  primaryAuthor: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  source: string | null;
  olWorkId: string | null;
  olRatingAvg: number | null;
  olRatingCount: number | null;
}) {
  return {
    id: b.id,
    title: b.title,
    authors: b.authors,
    primaryAuthor: b.primaryAuthor,
    isbn10: b.isbn10,
    isbn13: b.isbn13,
    publisher: b.publisher,
    publishedAt: b.publishedAt,
    thumbnailUrl: b.thumbnailUrl,
    source: b.source,
    olWorkId: b.olWorkId,
    olRatingAvg: b.olRatingAvg,
    olRatingCount: b.olRatingCount,
  };
}
