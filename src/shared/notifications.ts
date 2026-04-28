import { prisma } from "./db.js";
import type { Prisma } from "@prisma/client";
import { logger } from "./logger.js";

export type NotificationKind = "trophy-acquired" | "book-added";

export interface TrophyAcquiredPayload {
  bookTitle: string;
  bookAuthors: string[];
  acquiredByDisplayName: string;
  requestedByDiscordUserId: string;
  libraryName: string;
}

export interface BookAddedPayload {
  channelId: string;
  destination: "library" | "trophy";
  bookTitle: string;
  bookAuthors: string[];
  bookId: string;
  isbn13: string | null;
  thumbnailUrl: string | null;
  edition: string | null;
  ratingAvg: number | null;
  ratingCount: number | null;
  libraryName: string;
}

/**
 * Enqueue a notification for the bot to deliver. Best-effort — failures
 * are logged but never bubble up so they can't break the originating
 * mutation.
 */
export async function enqueueNotification(
  kind: NotificationKind,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.outboundNotification.create({
      data: { kind, payload: payload as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.warn({ err, kind }, "enqueue notification failed");
  }
}
