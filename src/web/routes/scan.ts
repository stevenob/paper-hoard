import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMembership, recordScan } from "../../shared/repo.js";
import { prisma } from "../../shared/db.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";
import { enqueueNotification, type BookAddedPayload } from "../../shared/notifications.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const scanSchema = z.object({
  isbn: z.string().trim().optional(),
  title: z.string().trim().optional(),
  author: z.string().trim().optional(),
  share: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
});

function shouldShare(input: unknown): boolean {
  return input === true || input === "true";
}

export async function scanRoutes(app: FastifyInstance) {
  app.get("/scan", async (req, reply) => {
    const recent = await prisma.physicalCopy.findMany({
      include: { book: true, addedBy: true },
      orderBy: { addedAt: "desc" },
      take: 5,
    });
    return reply.view("scan.ejs", await withChrome(req, { recent }));
  });

  // JSON endpoint hit by the in-page camera scanner.
  app.post("/scan", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library)
      return reply
        .status(400)
        .send({ ok: false, error: "No family library yet. Run /library in Discord first." });

    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ ok: false, error: "Invalid request." });
    if (!parsed.data.isbn && !parsed.data.title)
      return reply.status(400).send({ ok: false, error: "Provide an ISBN or title." });

    await ensureMembership(user.id, library.id);
    const result = await recordScan({
      libraryId: library.id,
      userId: user.id,
      isbn: parsed.data.isbn,
      title: parsed.data.title,
      author: parsed.data.author,
    });
    if (!result) return reply.status(404).send({ ok: false, error: "No matching book found." });

    // Optional Discord channel post — only if the library has a configured
    // channel AND the client opted in.
    if (shouldShare(parsed.data.share) && library.notifyChannelId) {
      const payload: BookAddedPayload = {
        channelId: library.notifyChannelId,
        destination: "library",
        bookTitle: result.meta.title,
        bookAuthors: result.meta.authors,
        bookId: result.book.id,
        isbn13: result.meta.isbn13 ?? null,
        thumbnailUrl: result.meta.thumbnailUrl ?? null,
        edition: result.copy.edition ?? null,
        ratingAvg: result.book.olRatingAvg,
        ratingCount: result.book.olRatingCount,
        libraryName: library.name,
      };
      void enqueueNotification("book-added", payload as unknown as Record<string, unknown>);
    }

    return reply.send({
      ok: true,
      trophyAcquired: result.trophyAcquired,
      copyId: result.copy.id,
      suggestedEdition: result.meta.edition ?? null,
      shareEnabled: Boolean(library.notifyChannelId),
      book: {
        title: result.meta.title,
        authors: result.meta.authors,
        isbn13: result.meta.isbn13,
        thumbnailUrl: result.meta.thumbnailUrl,
        source: result.meta.source,
      },
    });
  });

  // Lookup-only — used by the camera overlay to preview metadata before
  // committing. Mirrors the auth/library checks of POST /scan but doesn't
  // mutate anything.
  app.post("/scan/lookup", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library)
      return reply
        .status(400)
        .send({ ok: false, error: "No family library yet. Run /library in Discord first." });

    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ ok: false, error: "Invalid request." });
    if (!parsed.data.isbn && !parsed.data.title)
      return reply.status(400).send({ ok: false, error: "Provide an ISBN or title." });

    const meta = parsed.data.isbn
      ? await (await import("../../shared/metadata.js")).lookupByIsbn(parsed.data.isbn)
      : (await (await import("../../shared/metadata.js")).searchByTitle(
          [parsed.data.title, parsed.data.author].filter(Boolean).join(" ")
        ))[0];
    if (!meta) return reply.status(404).send({ ok: false, error: "No matching book found." });

    // Trophy preview without committing.
    const matchingBook = meta.isbn13
      ? await prisma.book.findUnique({ where: { isbn13: meta.isbn13 } })
      : null;
    const [trophyMatch, existingCopies] = matchingBook
      ? await Promise.all([
          prisma.trophy.findUnique({
            where: { libraryId_bookId: { libraryId: library.id, bookId: matchingBook.id } },
            include: { requestedBy: true },
          }),
          prisma.physicalCopy.findMany({
            where: { libraryId: library.id, bookId: matchingBook.id },
            include: { addedBy: true },
            orderBy: { addedAt: "asc" },
          }),
        ])
      : [null, []];

    // Opportunistic rating: serve cached value when we have one. If the
    // matching Book has a stale (or never-fetched) cache, kick off a refresh
    // in the background so the *next* scan / page view picks it up — never
    // block the scan response on the upstream call.
    let rating: { avg: number; count: number } | null = null;
    if (matchingBook) {
      if (matchingBook.olRatingAvg !== null && (matchingBook.olRatingCount ?? 0) > 0) {
        rating = { avg: matchingBook.olRatingAvg, count: matchingBook.olRatingCount! };
      }
      if (isStale(matchingBook.olFetchedAt)) {
        void refreshOpenLibraryRatings(matchingBook.id);
      }
    }

    return reply.send({
      ok: true,
      shareEnabled: Boolean(library.notifyChannelId),
      book: {
        title: meta.title,
        authors: meta.authors,
        isbn13: meta.isbn13,
        thumbnailUrl: meta.thumbnailUrl,
        source: meta.source,
        edition: meta.edition ?? null,
      },
      rating,
      trophy: trophyMatch
        ? { requestedBy: trophyMatch.requestedBy.displayName, reason: trophyMatch.reason }
        : null,
      existingCopies: existingCopies.map((c) => ({
        id: c.id,
        edition: c.edition,
        condition: c.condition,
        location: c.location,
        addedBy: c.addedBy.displayName,
        addedAt: c.addedAt.toISOString().slice(0, 10),
      })),
    });
  });
}
