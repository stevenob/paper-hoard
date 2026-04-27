import type { Client } from "discord.js";
import { prisma } from "../shared/db.js";
import { logger } from "../shared/logger.js";

const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 5;

interface TrophyAcquiredPayload {
  bookTitle: string;
  bookAuthors: string[];
  acquiredByDisplayName: string;
  requestedByDiscordUserId: string;
  libraryName: string;
}

async function processOne(client: Client, n: { id: string; kind: string; payload: unknown }) {
  if (n.kind === "trophy-acquired") {
    const p = n.payload as TrophyAcquiredPayload;
    const user = await client.users.fetch(p.requestedByDiscordUserId);
    const authors = p.bookAuthors.join(", ") || "Unknown author";
    await user.send(
      `🏆 **${p.bookTitle}** by ${authors} was just acquired for the **${p.libraryName}** library by ${p.acquiredByDisplayName}. Your trophy is fulfilled!`
    );
    return;
  }
  throw new Error(`unknown notification kind: ${n.kind}`);
}

async function tick(client: Client) {
  // Pull a small batch of pending rows. We use updateMany to grab + lock in
  // one round-trip via attempts increment so concurrent bot replicas (if
  // any) don't double-send.
  const pending = await prisma.outboundNotification.findMany({
    where: { status: "pending", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  for (const n of pending) {
    try {
      await processOne(client, n);
      await prisma.outboundNotification.update({
        where: { id: n.id },
        data: { status: "sent", processedAt: new Date(), attempts: { increment: 1 } },
      });
      logger.info({ id: n.id, kind: n.kind }, "notification sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = n.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await prisma.outboundNotification.update({
        where: { id: n.id },
        data: { status, attempts, lastError: message, processedAt: new Date() },
      });
      logger.warn({ err, id: n.id, attempts, status }, "notification delivery failed");
    }
  }
}

export function startNotificationPoller(client: Client) {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    try {
      await tick(client);
    } catch (err) {
      logger.error({ err }, "notification poller tick error");
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  setTimeout(loop, POLL_INTERVAL_MS);
  return () => {
    stopped = true;
  };
}
