import { prisma } from "./db.js";
import type { BookMetadata } from "./metadata.js";
import { lookupByIsbn, searchByTitle } from "./metadata.js";

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
 * Used by both the Discord /scan command and the web /scan page so behaviour
 * stays in sync.
 */
export async function recordScan(args: {
  libraryId: string;
  userId: string;
  isbn?: string;
  title?: string;
  author?: string;
}): Promise<ScanResult | null> {
  const meta = args.isbn
    ? await lookupByIsbn(args.isbn)
    : args.title
      ? (await searchByTitle([args.title, args.author].filter(Boolean).join(" ")))[0]
      : null;
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

  return { book, copy, trophyAcquired: Boolean(trophy), meta };
}
