import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMembership, recordScan } from "../../shared/repo.js";
import { prisma } from "../../shared/db.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";
import { enqueueNotification, type BookAddedPayload } from "../../shared/notifications.js";
import type { BookMetadata } from "../../shared/metadata.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

/**
 * Resolve metadata for a scan request, preferring a local Book row when
 * one exists with usable data. Skips the upstream Google Books / Open
 * Library round-trip on re-scans, saving 500–2000 ms of perceived latency.
 */
async function resolveMeta(
  isbn: string | undefined,
  title: string | undefined,
  author: string | undefined
): Promise<BookMetadata | null> {
  if (isbn) {
    const cleaned = isbn.replace(/[^0-9Xx]/g, "");
    if (cleaned) {
      const cached = await prisma.book.findUnique({ where: { isbn13: cleaned } });
      if (cached && cached.title && cached.authors.length > 0) {
        // Map the persisted source back to the BookMetadata source enum.
        // Anything unknown (older rows, or 'cache' marker) falls through
        // to 'manual' which is the safe choice — recordScan won't
        // overwrite manually-curated fields downstream.
        const src: "google_books" | "open_library" | "manual" =
          cached.source === "google_books" || cached.source === "open_library"
            ? cached.source
            : "manual";
        return {
          title: cached.title,
          authors: cached.authors,
          isbn10: cached.isbn10 ?? undefined,
          isbn13: cached.isbn13 ?? undefined,
          publisher: cached.publisher ?? undefined,
          publishedAt: cached.publishedAt ?? undefined,
          thumbnailUrl: cached.thumbnailUrl ?? undefined,
          source: src,
        };
      }
    }
  }
  const md = await import("../../shared/metadata.js");
  if (isbn) return md.lookupByIsbn(isbn);
  if (title) {
    const results = await md.searchByTitle([title, author].filter(Boolean).join(" "));
    return results[0] ?? null;
  }
  return null;
}

const scanSchema = z.object({
  isbn: z.string().trim().optional(),
  title: z.string().trim().optional(),
  author: z.string().trim().optional(),
  share: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  // Optional user overrides applied AFTER metadata lookup. Used when the
  // ISBN is in Google Books / Open Library but the source data is missing
  // critical fields (most commonly the author array is empty for older
  // books and indie presses).
  overrideTitle: z.string().trim().max(500).optional(),
  overrideAuthors: z.string().trim().max(1000).optional(),
  overridePublisher: z.string().trim().max(200).optional(),
  overrideEdition: z.string().trim().max(50).optional(),
  // Optional trophy reason — captured when tapping 🏆 in the scan flow
  // ("for Sam's birthday", "anniversary trip", etc.). Stored on the
  // Trophy row by /scan/trophy. Ignored by other endpoints.
  reason: z.string().trim().max(500).optional(),
  // Optional max purchase price — when present, the field-lookup chip
  // can warn if the spotted price exceeds the user's ceiling.
  maxPrice: z.string().trim().max(20).optional(),
  // Optional edition specifics ("must be 1st UK printing", "any
  // hardcover is fine"). Free-form, shown verbatim on the scan match.
  editionNotes: z.string().trim().max(500).optional(),
});

function shouldShare(input: unknown): boolean {
  return input === true || input === "true";
}

function parseAuthorList(s: string | undefined): string[] | null {
  if (!s) return null;
  const list = s.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
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
    // DB-cache fast path: resolveMeta returns a local Book row when the
    // ISBN is already known, skipping Google/OL on re-scans.
    const preMeta = await resolveMeta(parsed.data.isbn, parsed.data.title, parsed.data.author);
    if (!preMeta && parsed.data.isbn) {
      // Only fail here if we explicitly have an ISBN and no upstream match.
      // Title-only path falls through to recordScan's own lookup below.
      return reply.status(404).send({ ok: false, error: "No matching book found." });
    }
    const result = await recordScan({
      libraryId: library.id,
      userId: user.id,
      isbn: parsed.data.isbn,
      title: parsed.data.title,
      author: parsed.data.author,
      meta: preMeta ?? undefined,
    });
    if (!result) return reply.status(404).send({ ok: false, error: "No matching book found." });

    // Apply user overrides on top of the metadata lookup. Anything left
    // blank in the override falls back to whatever the source returned.
    const overrideAuthors = parseAuthorList(parsed.data.overrideAuthors);
    const bookUpdate: Record<string, unknown> = {};
    if (parsed.data.overrideTitle && parsed.data.overrideTitle !== result.meta.title) {
      bookUpdate.title = parsed.data.overrideTitle;
    }
    if (overrideAuthors) {
      bookUpdate.authors = overrideAuthors;
      bookUpdate.primaryAuthor = overrideAuthors[0];
    }
    if (parsed.data.overridePublisher) {
      bookUpdate.publisher = parsed.data.overridePublisher;
    }
    if (Object.keys(bookUpdate).length > 0) {
      // Mark as manual so future automatic refetches don't clobber the
      // user's edits.
      bookUpdate.source = "manual";
      await prisma.book.update({ where: { id: result.book.id }, data: bookUpdate });
    }
    if (parsed.data.overrideEdition !== undefined) {
      const trimmed = parsed.data.overrideEdition.trim();
      if (trimmed !== (result.copy.edition ?? "")) {
        await prisma.physicalCopy.update({
          where: { id: result.copy.id },
          data: { edition: trimmed || null },
        });
      }
    }

    // Effective title/authors used in any downstream Discord post.
    const effectiveTitle = (bookUpdate.title as string | undefined) ?? result.meta.title;
    const effectiveAuthors = (bookUpdate.authors as string[] | undefined) ?? result.meta.authors;

    // Optional Discord channel post — only if the library has a configured
    // channel AND the client opted in.
    if (shouldShare(parsed.data.share) && library.notifyChannelId) {
      const payload: BookAddedPayload = {
        channelId: library.notifyChannelId,
        destination: "library",
        bookTitle: effectiveTitle,
        bookAuthors: effectiveAuthors,
        bookId: result.book.id,
        isbn13: result.meta.isbn13 ?? null,
        thumbnailUrl: result.meta.thumbnailUrl ?? null,
        edition: (parsed.data.overrideEdition?.trim() || result.copy.edition) ?? null,
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
        title: effectiveTitle,
        authors: effectiveAuthors,
        isbn13: result.meta.isbn13,
        thumbnailUrl: result.meta.thumbnailUrl,
        source: bookUpdate.source ?? result.meta.source,
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

    const meta = await resolveMeta(parsed.data.isbn, parsed.data.title, parsed.data.author);
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
        ? {
            requestedBy: trophyMatch.requestedBy.displayName,
            reason: trophyMatch.reason,
            editionNotes: trophyMatch.editionNotes,
            maxPriceCents: trophyMatch.maxPriceCents,
            status: trophyMatch.status,
          }
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

    const meta = await resolveMeta(parsed.data.isbn, parsed.data.title, parsed.data.author);
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
        where: { libraryId: library.id, status: "active", book: { isbn13: { not: null } } },
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

    const meta = await resolveMeta(parsed.data.isbn, parsed.data.title, parsed.data.author);
    if (!meta) return reply.status(404).send({ ok: false, error: "No matching book found." });

    const { upsertBookFromMetadata } = await import("../../shared/repo.js");
    const { audit } = await import("../../shared/audit.js");
    await ensureMembership(user.id, library.id);
    const book = await upsertBookFromMetadata(meta);

    // Idempotent: if the trophy already exists, just return ok with the
    // existing record so the UI can show the "already on trophy list" chip.
    // If a reason is supplied AND the existing trophy didn't have one, fill
    // it in — useful when the user re-scans to add a reason after the fact.
    const reason = parsed.data.reason?.trim() || null;
    const editionNotes = parsed.data.editionNotes?.trim() || null;
    const maxPriceCents = (() => {
      const raw = parsed.data.maxPrice?.trim();
      if (!raw) return null;
      const cleaned = raw.replace(/[^0-9.]/g, "");
      if (!cleaned) return null;
      const n = Number.parseFloat(cleaned);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 100);
    })();
    const existing = await prisma.trophy.findUnique({
      where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
    });
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (reason && !existing.reason) patch.reason = reason;
      if (editionNotes && !existing.editionNotes) patch.editionNotes = editionNotes;
      if (maxPriceCents !== null && !existing.maxPriceCents) patch.maxPriceCents = maxPriceCents;
      if (Object.keys(patch).length > 0) {
        await prisma.trophy.update({ where: { id: existing.id }, data: patch });
      }
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
        reason,
        editionNotes,
        maxPriceCents,
      },
    });
    void audit({
      userId: user.id,
      action: "create",
      entity: "trophy",
      entityId: trophy.id,
      details: { source: "scan", bookId: book.id, reason: reason ?? undefined },
    });
    return reply.send({
      ok: true,
      alreadyExists: false,
      trophyId: trophy.id,
      book: { title: meta.title, authors: meta.authors, isbn13: meta.isbn13 },
    });
  });
}
