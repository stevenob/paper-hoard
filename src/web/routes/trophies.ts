import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { searchByTitle, lookupByIsbn } from "../../shared/metadata.js";
import { upsertBookFromMetadata } from "../../shared/repo.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const AGED_THRESHOLD_DAYS = 180;

export async function trophiesRoutes(app: FastifyInstance) {
  app.get("/trophies", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const trophies = await prisma.trophy.findMany({
      where: library ? { libraryId: library.id } : {},
      include: { book: true, requestedBy: true, library: true },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    // Stats for the hero dashboard.
    const now = Date.now();
    const agedCutoffMs = AGED_THRESHOLD_DAYS * 86400 * 1000;
    let activeCount = 0;
    let deferredCount = 0;
    let agedCount = 0;
    let oldestDays = 0;
    let totalMaxBudgetCents = 0;
    for (const t of trophies) {
      if (t.status === "deferred") deferredCount++;
      else activeCount++;
      const ageMs = now - new Date(t.createdAt).getTime();
      const days = Math.floor(ageMs / 86400000);
      if (days > oldestDays) oldestDays = days;
      if (t.status !== "deferred" && ageMs >= agedCutoffMs) agedCount++;
      if (t.status !== "deferred" && t.maxPriceCents) totalMaxBudgetCents += t.maxPriceCents;
    }

    return reply.view(
      "trophies.ejs",
      await withChrome(req, {
        trophies,
        library,
        stats: {
          activeCount,
          deferredCount,
          agedCount,
          oldestDays,
          totalMaxBudgetCents,
          agedThresholdDays: AGED_THRESHOLD_DAYS,
        },
      })
    );
  });

  /**
   * Smart-search endpoint for the +Add trophy modal. Accepts a free-text
   * query (title, or paste an ISBN) and returns up to 5 candidates from
   * Google Books / Open Library. Read-only — does not write anything.
   */
  app.post("/trophies/search", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = z.object({ q: z.string().trim().min(2).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, error: "Invalid query" });
    const q = parsed.data.q;
    // ISBN-shaped queries: do an exact lookup that returns at most one hit.
    const isbnDigits = q.replace(/[^0-9Xx]/g, "");
    if (isbnDigits.length === 10 || isbnDigits.length === 13) {
      const meta = await lookupByIsbn(isbnDigits);
      return reply.send({ ok: true, results: meta ? [meta] : [] });
    }
    const results = await searchByTitle(q);
    return reply.send({ ok: true, results: results.slice(0, 5) });
  });

  /**
   * Create a Trophy from the +Add modal. Either {isbn} (preferred — looks
   * up live so we always have title/cover/publisher) or a manual
   * {title, author?, isbn?} pair.
   */
  const createSchema = z.object({
    isbn: z.string().optional(),
    title: z.string().trim().min(1).max(500).optional(),
    author: z.string().trim().max(500).optional(),
    editionNotes: z.string().trim().max(500).optional(),
    maxPriceCents: z.number().int().min(0).max(1_000_000_00).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    reason: z.string().trim().max(2000).optional(),
  });

  app.post("/trophies/new", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library)
      return reply.status(400).send({ ok: false, error: "No library configured." });

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ ok: false, error: "Invalid request." });
    const { isbn, title, author, editionNotes, maxPriceCents, priority, reason } = parsed.data;

    // Resolve a Book row. If an ISBN is provided, look it up live so we
    // capture the latest cover + publisher; falling back to manual data.
    let book;
    if (isbn) {
      const meta = await lookupByIsbn(isbn);
      if (meta) {
        book = await upsertBookFromMetadata(meta);
      } else if (title) {
        // ISBN didn't resolve but user typed a title — store as manual.
        book = await upsertBookFromMetadata({
          title,
          authors: author ? [author] : [],
          isbn13: isbn.length === 13 ? isbn : undefined,
          isbn10: isbn.length === 10 ? isbn : undefined,
          source: "manual",
        });
      } else {
        return reply
          .status(404)
          .send({ ok: false, error: "ISBN not found in any source. Add manually with a title." });
      }
    } else if (title) {
      book = await upsertBookFromMetadata({
        title,
        authors: author ? [author] : [],
        source: "manual",
      });
    } else {
      return reply.status(400).send({ ok: false, error: "Provide an ISBN or title." });
    }

    // Idempotent: re-using @@unique([libraryId, bookId]) so re-submitting
    // the same book updates the trophy fields rather than 500ing.
    const trophy = await prisma.trophy.upsert({
      where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
      create: {
        libraryId: library.id,
        bookId: book.id,
        requestedByUserId: user.id,
        editionNotes: editionNotes ?? null,
        maxPriceCents: maxPriceCents ?? null,
        priority: priority ?? 3,
        reason: reason ?? null,
        status: "active",
      },
      update: {
        editionNotes: editionNotes ?? null,
        maxPriceCents: maxPriceCents ?? null,
        priority: priority ?? 3,
        reason: reason ?? null,
        status: "active",
      },
    });

    void audit({
      userId: user.id,
      action: "create",
      entity: "trophy",
      entityId: trophy.id,
      details: { bookId: book.id, libraryId: library.id, manual: !isbn },
    });

    return reply.send({ ok: true, trophyId: trophy.id, bookId: book.id });
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const removed = await prisma.trophy.delete({ where: { id: req.params.id } }).catch(() => null);
    if (removed) {
      void audit({
        userId: user.id,
        action: "delete",
        entity: "trophy",
        entityId: removed.id,
        details: { bookId: removed.bookId, libraryId: removed.libraryId },
      });
    }
    return reply.redirect("/trophies");
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/defer", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.trophy
      .update({ where: { id: req.params.id }, data: { status: "deferred" } })
      .catch(() => null);
    void audit({
      userId: user.id,
      action: "update",
      entity: "trophy",
      entityId: req.params.id,
      details: { status: "deferred" },
    });
    return reply.redirect("/trophies");
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/activate", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.trophy
      .update({ where: { id: req.params.id }, data: { status: "active" } })
      .catch(() => null);
    void audit({
      userId: user.id,
      action: "update",
      entity: "trophy",
      entityId: req.params.id,
      details: { status: "active" },
    });
    return reply.redirect("/trophies");
  });
}
