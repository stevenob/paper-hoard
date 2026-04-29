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
      where: { deletedAt: null },
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
            where: { libraryId: library.id, bookId: matchingBook.id, deletedAt: null },
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
        addedBy: c.addedBy.displayName,
        addedAt: c.addedAt.toISOString().slice(0, 10),
      })),
    });
  });

  // Share-only — posts to the configured Discord channel without creating
  // any DB row. Use case: "spotted in a bookstore, what do you think?"
  app.post("/scan/share", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(400).send({ ok: false, error: "No family library yet." });
    if (!library.notifyChannelId)
      return reply.status(400).send({ ok: false, error: "No Discord channel configured." });

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

    const cached = meta.isbn13
      ? await prisma.book.findUnique({ where: { isbn13: meta.isbn13 } })
      : null;

    const payload: BookAddedPayload = {
      channelId: library.notifyChannelId,
      destination: "library",
      bookTitle: meta.title,
      bookAuthors: meta.authors,
      bookId: cached?.id ?? "(uncatalogued)",
      isbn13: meta.isbn13 ?? null,
      thumbnailUrl: meta.thumbnailUrl ?? null,
      edition: meta.edition ?? null,
      ratingAvg: cached?.olRatingAvg ?? null,
      ratingCount: cached?.olRatingCount ?? null,
      libraryName: library.name,
    };
    void enqueueNotification("book-shared", payload as unknown as Record<string, unknown>);
    return reply.send({ ok: true });
  });

  // Lightweight ISBN cache for offline/instant "do I already own this?"
  // checks in the camera UI. Returns just the ISBNs in this library so the
  // browser can flag a scanned barcode before any network round-trip.
  app.get("/scan/cache.json", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.send({ owned: [], trophy: [] });
    const [owned, trophy] = await Promise.all([
      prisma.physicalCopy.findMany({
        where: { libraryId: library.id, deletedAt: null, book: { isbn13: { not: null } } },
        select: { book: { select: { isbn13: true } } },
        distinct: ["bookId"],
      }),
      prisma.trophy.findMany({
        where: { libraryId: library.id, book: { isbn13: { not: null } } },
        select: { book: { select: { isbn13: true } } },
      }),
    ]);
    reply.header("Cache-Control", "no-cache");
    return reply.send({
      owned: owned.map((c) => c.book.isbn13!).filter(Boolean),
      trophy: trophy.map((t) => t.book.isbn13!).filter(Boolean),
    });
  });

  // Add a scanned book directly to the trophy list without saving a copy.
  // Use case: spotted a book in a store, want it for later but don't have
  // it in hand. Same payload shape as /scan.
  app.post("/scan/trophy", async (req, reply) => {
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

    const { lookupByIsbn, searchByTitle } = await import("../../shared/metadata.js");
    const meta = parsed.data.isbn
      ? await lookupByIsbn(parsed.data.isbn)
      : (await searchByTitle(
          [parsed.data.title, parsed.data.author].filter(Boolean).join(" ")
        ))[0];
    if (!meta) return reply.status(404).send({ ok: false, error: "No matching book found." });

    const { upsertBookFromMetadata } = await import("../../shared/repo.js");
    const { audit } = await import("../../shared/audit.js");
    await ensureMembership(user.id, library.id);
    const book = await upsertBookFromMetadata(meta);

    // Idempotent: if the trophy already exists, just return ok with the
    // existing record so the UI can show the "already on trophy list" chip.
    const existing = await prisma.trophy.findUnique({
      where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
    });
    if (existing) {
      return reply.send({
        ok: true,
        alreadyExists: true,
        trophyId: existing.id,
        book: { title: meta.title, authors: meta.authors, isbn13: meta.isbn13 },
      });
    }
    const trophy = await prisma.trophy.create({
      data: {
        libraryId: library.id,
        bookId: book.id,
        requestedByUserId: user.id,
        priority: 3,
      },
    });
    void audit({
      userId: user.id,
      action: "create",
      entity: "trophy",
      entityId: trophy.id,
      details: { source: "scan", bookId: book.id },
    });
    return reply.send({
      ok: true,
      alreadyExists: false,
      trophyId: trophy.id,
      book: { title: meta.title, authors: meta.authors, isbn13: meta.isbn13 },
    });
  });
}
