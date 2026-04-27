import { prisma } from "./db.js";
import type { BookMetadata } from "./metadata.js";
import { lookupByIsbn, searchByTitle } from "./metadata.js";
import { audit } from "./audit.js";

export async function upsertLibrary(discordGuildId: string, name: string) {
  return prisma.library.upsert({
    where: { discordGuildId },
    create: { discordGuildId, name },
    update: { name },
  });
}

export async function upsertUser(discordUserId: string, displayName: string) {
  return prisma.user.upsert({
    where: { discordUserId },
    create: { discordUserId, displayName },
    update: { displayName },
  });
}

export async function ensureMembership(userId: string, libraryId: string) {
  return prisma.membership.upsert({
    where: { userId_libraryId: { userId, libraryId } },
    create: { userId, libraryId },
    update: {},
  });
}

export async function upsertBookFromMetadata(meta: BookMetadata) {
  if (meta.isbn13) {
    return prisma.book.upsert({
      where: { isbn13: meta.isbn13 },
      create: {
        isbn13: meta.isbn13,
        isbn10: meta.isbn10,
        title: meta.title,
        authors: meta.authors,
        publisher: meta.publisher,
        publishedAt: meta.publishedAt,
        thumbnailUrl: meta.thumbnailUrl,
        source: meta.source,
      },
      update: {
        title: meta.title,
        authors: meta.authors,
        publisher: meta.publisher,
        publishedAt: meta.publishedAt,
        thumbnailUrl: meta.thumbnailUrl,
      },
    });
  }
  // No ISBN — create a fresh record (manual de-dup left to UI later).
  return prisma.book.create({
    data: {
      isbn10: meta.isbn10,
      title: meta.title,
      authors: meta.authors,
      publisher: meta.publisher,
      publishedAt: meta.publishedAt,
      thumbnailUrl: meta.thumbnailUrl,
      source: meta.source,
    },
  });
}

export interface ScanResult {
  book: Awaited<ReturnType<typeof upsertBookFromMetadata>>;
  copy: Awaited<ReturnType<typeof prisma.physicalCopy.create>>;
  trophyAcquired: boolean;
  meta: BookMetadata;
}

/**
 * Look up a book by ISBN (or title fallback), record a PhysicalCopy under the
 * given library/user, and remove a matching Trophy if one existed.
 *
 * Used by the web /scan endpoint where a single round-trip should commit
 * everything. Smaug uses the lower-level helpers below to support a
 * confirm-trophy-match flow.
 */
export async function recordScan(args: {
  libraryId: string;
  userId: string;
  isbn?: string;
  title?: string;
  author?: string;
}): Promise<ScanResult | null> {
  const meta = await lookupBook(args);
  if (!meta) return null;

  const book = await upsertBookFromMetadata(meta);

  const trophy = await prisma.trophy.findUnique({
    where: { libraryId_bookId: { libraryId: args.libraryId, bookId: book.id } },
  });

  const copy = await prisma.physicalCopy.create({
    data: {
      bookId: book.id,
      libraryId: args.libraryId,
      addedByUserId: args.userId,
    },
  });

  if (trophy) await prisma.trophy.delete({ where: { id: trophy.id } });
  if (trophy) {
    void audit({
      userId: args.userId,
      action: "delete",
      entity: "trophy",
      entityId: trophy.id,
      details: { source: "scan-acquired", bookId: book.id },
    });
  }
  void audit({
    userId: args.userId,
    action: "create",
    entity: "physicalCopy",
    entityId: copy.id,
    details: { bookId: book.id, libraryId: args.libraryId, source: "scan" },
  });

  return { book, copy, trophyAcquired: Boolean(trophy), meta };
}

/**
 * Lookup-only — Smaug uses this to preview a match before committing,
 * so a Trophy match can be confirmed by the user instead of auto-applied.
 */
export async function lookupBook(args: {
  isbn?: string;
  title?: string;
  author?: string;
}): Promise<BookMetadata | null> {
  if (args.isbn) return lookupByIsbn(args.isbn);
  if (args.title) {
    const results = await searchByTitle([args.title, args.author].filter(Boolean).join(" "));
    return results[0] ?? null;
  }
  return null;
}

export async function createPhysicalCopy(args: {
  libraryId: string;
  userId: string;
  bookId: string;
}) {
  const copy = await prisma.physicalCopy.create({
    data: {
      bookId: args.bookId,
      libraryId: args.libraryId,
      addedByUserId: args.userId,
    },
  });
  void audit({
    userId: args.userId,
    action: "create",
    entity: "physicalCopy",
    entityId: copy.id,
    details: { bookId: args.bookId, libraryId: args.libraryId },
  });
  return copy;
}

export async function deleteTrophyIfExists(libraryId: string, bookId: string) {
  const removed = await prisma.trophy
    .delete({ where: { libraryId_bookId: { libraryId, bookId } } })
    .catch(() => null);
  if (removed) {
    void audit({
      action: "delete",
      entity: "trophy",
      entityId: removed.id,
      details: { libraryId, bookId },
    });
  }
  return removed;
}
