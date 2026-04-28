import { prisma } from "./db.js";
import { audit } from "./audit.js";

/**
 * Mark a user as currently reading a specific physical copy. Idempotent —
 * if there is already an unfinished reading for this user+copy, return it
 * without creating a duplicate.
 */
export async function startReading(args: {
  userId: string;
  libraryId: string;
  copyId: string;
}) {
  const existing = await prisma.reading.findFirst({
    where: { userId: args.userId, copyId: args.copyId, finishedAt: null },
  });
  if (existing) return existing;
  const reading = await prisma.reading.create({
    data: {
      userId: args.userId,
      libraryId: args.libraryId,
      copyId: args.copyId,
    },
  });
  void audit({
    userId: args.userId,
    action: "create",
    entity: "reading",
    entityId: reading.id,
    details: { copyId: args.copyId },
  });
  return reading;
}

/**
 * Mark a reading as finished. If `createCompletion` is true, also writes a
 * Completion row for the same book (mediaType=physical) so the user's
 * "Completions" list shows it.
 */
export async function finishReading(args: {
  readingId: string;
  userId: string;
  createCompletion: boolean;
  rating?: number | null;
  notes?: string | null;
}) {
  const reading = await prisma.reading.findUnique({
    where: { id: args.readingId },
    include: { copy: { include: { book: true } } },
  });
  if (!reading) return null;
  if (reading.finishedAt) return reading;
  const updated = await prisma.reading.update({
    where: { id: args.readingId },
    data: { finishedAt: new Date(), notes: args.notes ?? reading.notes },
  });
  void audit({
    userId: args.userId,
    action: "update",
    entity: "reading",
    entityId: reading.id,
    details: { finished: true },
  });
  if (args.createCompletion) {
    const completion = await prisma.completion.create({
      data: {
        userId: reading.userId,
        libraryId: reading.libraryId,
        bookId: reading.copy.bookId,
        mediaType: "physical",
        completedOn: new Date(),
        rating: args.rating ?? null,
        notes: args.notes ?? null,
      },
    });
    void audit({
      userId: args.userId,
      action: "create",
      entity: "completion",
      entityId: completion.id,
      details: { source: "reading-finished", bookId: reading.copy.bookId },
    });
  }
  return updated;
}
