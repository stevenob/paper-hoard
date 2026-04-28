import { Client, EmbedBuilder } from "discord.js";
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

interface BookAddedPayload {
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

function externalLinks(isbn13: string | null, title: string): string {
  const q = isbn13 || title;
  if (!q) return "";
  const enc = encodeURIComponent(q);
  const lines: string[] = [];
  lines.push(`[Goodreads](https://www.goodreads.com/search?q=${enc})`);
  lines.push(`[StoryGraph](https://app.thestorygraph.com/browse?search_term=${enc})`);
  if (isbn13) {
    lines.push(`[LibraryThing](https://www.librarything.com/isbn/${isbn13})`);
    lines.push(`[Open Library](https://openlibrary.org/isbn/${isbn13})`);
    lines.push(`[Bookshop](https://bookshop.org/search?keywords=${isbn13})`);
    lines.push(`[Amazon](https://www.amazon.com/s?k=${isbn13})`);
  }
  return lines.join(" · ");
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
  if (n.kind === "book-added") {
    const p = n.payload as BookAddedPayload;
    const channel = await client.channels.fetch(p.channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`channel ${p.channelId} not found or not text-sendable`);
    }
    const verb = p.destination === "trophy" ? "🏆 Added to the Trophy List" : "📚 Added to the library";
    const embed = new EmbedBuilder()
      .setTitle(p.bookTitle)
      .setDescription(p.bookAuthors.join(", ") || "Unknown author")
      .setFooter({ text: `${p.libraryName} • ${verb}` });
    if (p.thumbnailUrl) embed.setThumbnail(p.thumbnailUrl);
    if (p.isbn13) embed.addFields({ name: "ISBN", value: p.isbn13, inline: true });
    if (p.edition) embed.addFields({ name: "Binding", value: p.edition, inline: true });
    if (p.ratingAvg != null && (p.ratingCount ?? 0) > 0) {
      embed.addFields({
        name: "Rating",
        value: `⭐ ${p.ratingAvg.toFixed(2)} (${p.ratingCount} on Open Library)`,
        inline: true,
      });
    }
    const links = externalLinks(p.isbn13, p.bookTitle);
    if (links) embed.addFields({ name: "Reviews & buy", value: links });
    await channel.send({ embeds: [embed] });
    return;
  }
  throw new Error(`unknown notification kind: ${n.kind}`);
}

async function tick(client: Client) {
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
