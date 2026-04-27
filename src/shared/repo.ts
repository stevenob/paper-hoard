import { prisma } from "./db.js";
import type { BookMetadata } from "./metadata.js";

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
