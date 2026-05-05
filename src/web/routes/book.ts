import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";
import { ensureMembership } from "../../shared/repo.js";
import { EDITIONS } from "../../shared/picklists.js";
import { normalizeAsin } from "../../shared/kindle.js";
import { scheduleKindleAsinEnrichment } from "../../shared/kindle-enrichment.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const editSchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.string().max(1000).optional().default(""),
  publisher: z.string().max(200).optional().default(""),
  publishedAt: z.string().max(50).optional().default(""),
  isbn13: z.string().max(13).optional().default(""),
  thumbnailUrl: z.string().max(2000).optional().default(""),
  seriesName: z.string().max(200).optional().default(""),
  seriesPosition: z.string().max(20).optional().default(""),
  // Optional Kindle ASIN. Empty string clears, valid value sets,
  // malformed value is rejected with a 400 (single chokepoint via
  // normalizeAsin). The clear path leaves kindleAsinAttemptedAt
  // untouched so the next durable write doesn't immediately
  // re-fetch the same wrong ASIN from Open Library — the user has
  // a separate explicit "Try OL lookup again" action below.
  kindleAsin: z.string().max(20).optional().default(""),
});

const newSchema = editSchema.extend({
  edition: z.string().max(50).optional().default(""),
  condition: z.string().max(50).optional().default(""),
  shelfId: z.string().max(50).optional().default(""),
});

function blankToNull(v: string | undefined): string | null {
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function bookRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, string> }>("/books/new", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const prefill = {
      title: typeof req.query.title === "string" ? req.query.title.slice(0, 500) : "",
      authors: typeof req.query.authors === "string" ? req.query.authors.slice(0, 1000) : "",
      publisher: typeof req.query.publisher === "string" ? req.query.publisher.slice(0, 200) : "",
      publishedAt: typeof req.query.publishedAt === "string" ? req.query.publishedAt.slice(0, 50) : "",
      isbn13: typeof req.query.isbn === "string" ? req.query.isbn.replace(/[^0-9Xx]/g, "").slice(0, 13) : "",
      seriesName:
        typeof req.query.seriesName === "string" ? req.query.seriesName.slice(0, 200) : "",
      seriesPosition:
        typeof req.query.seriesPosition === "string" ? req.query.seriesPosition.slice(0, 20) : "",
      shelfId:
        typeof req.query.shelfId === "string" ? req.query.shelfId.slice(0, 50) : "",
    };
    const [shelves, seriesNamesRaw] = library
      ? await Promise.all([
          prisma.shelf.findMany({
            where: { libraryId: library.id },
            select: { id: true, name: true, _count: { select: { copies: true } } },
            orderBy: { name: "asc" },
          }),
          prisma.book.findMany({
            where: {
              seriesName: { not: null },
              physicalCopies: { some: { libraryId: library.id, deletedAt: null } },
            },
            select: { seriesName: true },
            distinct: ["seriesName"],
            orderBy: { seriesName: "asc" },
          }),
        ])
      : [[], []];
    const seriesNames = seriesNamesRaw
      .map((b) => b.seriesName)
      .filter((s): s is string => Boolean(s));
    return reply.view(
      "book_new.ejs",
      await withChrome(req, {
        prefill,
        editions: EDITIONS,
        shelves,
        seriesNames,
        error: null as string | null,
      })
    );
  });

  app.post("/books/new", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library)
      return reply
        .status(400)
        .send("No family library yet. Run /library in Discord first.");

    const parsed = newSchema.safeParse(req.body);
    if (!parsed.success) {
      const [shelves, seriesNamesRaw] = await Promise.all([
        prisma.shelf.findMany({
          where: { libraryId: library.id },
          select: { id: true, name: true, _count: { select: { copies: true } } },
          orderBy: { name: "asc" },
        }),
        prisma.book.findMany({
          where: {
            seriesName: { not: null },
            physicalCopies: { some: { libraryId: library.id, deletedAt: null } },
          },
          select: { seriesName: true },
          distinct: ["seriesName"],
          orderBy: { seriesName: "asc" },
        }),
      ]);
      return reply.view(
        "book_new.ejs",
        await withChrome(req, {
          prefill: req.body ?? {},
          editions: EDITIONS,
          shelves,
          seriesNames: seriesNamesRaw
            .map((b) => b.seriesName)
            .filter((s): s is string => Boolean(s)),
          error: parsed.error.issues.map((i) => i.message).join(", "),
        })
      );
    }
    const d = parsed.data;
    const isbn13 = d.isbn13.replace(/[^0-9Xx]/g, "").trim() || null;

    // Parse series position once — float, bounded, blank → null.
    const seriesPositionParsed = (() => {
      const raw = d.seriesPosition.trim();
      if (!raw) return null;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
    })();

    // If the ISBN already exists, reuse the book row rather than fail on
    // the unique constraint — this keeps the manual-entry flow forgiving.
    let book;
    const existing = isbn13
      ? await prisma.book.findUnique({ where: { isbn13 } })
      : null;
    const sharedFields: Prisma.BookCreateInput = {
      title: d.title.trim(),
      authors: d.authors
        ? d.authors.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      primaryAuthor:
        (d.authors
          ? d.authors.split(",").map((s) => s.trim()).filter(Boolean)[0]
          : null) ?? null,
      publisher: d.publisher.trim() || null,
      publishedAt: d.publishedAt.trim() || null,
      thumbnailUrl: d.thumbnailUrl.trim() || null,
      isbn13,
      source: "manual",
      seriesName: d.seriesName.trim() || null,
      seriesPosition: seriesPositionParsed,
    };
    if (existing) {
      // Don't clobber a series the existing row already has — same rule as
      // upsertBookFromMetadata, but applied here since manual is mutating.
      const update: Prisma.BookUpdateInput = { ...sharedFields };
      if (existing.seriesName && !d.seriesName.trim()) {
        delete (update as { seriesName?: unknown }).seriesName;
      }
      if (existing.seriesPosition != null && seriesPositionParsed === null) {
        delete (update as { seriesPosition?: unknown }).seriesPosition;
      }
      book = await prisma.book.update({ where: { id: existing.id }, data: update });
    } else {
      book = await prisma.book.create({ data: sharedFields });
    }
    void audit({
      userId: user.id,
      action: existing ? "update" : "create",
      entity: "book",
      entityId: book.id,
      details: { source: "manual-form" },
    });

    await ensureMembership(user.id, library.id);
    const copy = await prisma.physicalCopy.create({
      data: {
        bookId: book.id,
        libraryId: library.id,
        addedByUserId: user.id,
        edition: d.edition.trim() || null,
        condition: d.condition.trim() || null,
      },
    });
    void audit({
      userId: user.id,
      action: "create",
      entity: "physicalCopy",
      entityId: copy.id,
      details: { bookId: book.id, source: "manual-form" },
    });

    // Schedule a post-response Kindle ASIN enrichment now that the
    // physical copy is committed.
    scheduleKindleAsinEnrichment(reply, book.id);

    // Optional shelf assignment. Validates library scope and silently
    // ignores cross-library / unknown shelfId values.
    if (d.shelfId.trim()) {
      const shelf = await prisma.shelf.findFirst({
        where: { id: d.shelfId.trim(), libraryId: library.id },
        select: { id: true, name: true },
      });
      if (shelf) {
        await prisma.shelfCopy.create({
          data: { shelfId: shelf.id, copyId: copy.id },
        });
        void audit({
          userId: user.id,
          action: "update",
          entity: "physicalCopy",
          entityId: copy.id,
          details: { source: "manual-form-shelf-assign", shelf: shelf.name },
        });
      }
    }

    return reply.redirect(`/library/copy/${copy.id}`);
  });

  app.get<{ Params: { id: string }; Querystring: { refetched?: string } }>(
    "/books/:id",
    async (req, reply) => {
      const book = await prisma.book.findUnique({ where: { id: req.params.id } });
      if (!book) return reply.status(404).send("Not found");
      const [copies, completions, trophies] = await Promise.all([
      prisma.physicalCopy.findMany({
        where: { bookId: book.id, deletedAt: null },
        include: {
          addedBy: true,
          library: true,
          shelves: { include: { shelf: true } },
        },
        orderBy: { addedAt: "desc" },
      }),
      prisma.completion.findMany({
        where: { bookId: book.id },
        include: { user: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.trophy.findMany({
        where: { bookId: book.id },
        include: { requestedBy: true, library: true },
      }),
    ]);
    if (book.isbn13 && isStale(book.olFetchedAt)) {
      void refreshOpenLibraryRatings(book.id);
    }
    const shelfMap = new Map<string, { id: string; name: string; slug: string }>();
    copies.forEach((c) =>
      c.shelves.forEach((sc) => {
        if (!shelfMap.has(sc.shelf.id))
          shelfMap.set(sc.shelf.id, { id: sc.shelf.id, name: sc.shelf.name, slug: sc.shelf.slug });
      })
    );
    const shelves = Array.from(shelfMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return reply.view(
      "book.ejs",
      await withChrome(req, {
        book,
        copies,
        completions,
        trophies,
        shelves,
        refetched: req.query.refetched ?? null,
      })
    );
  });

  app.get<{ Params: { id: string } }>("/books/:id/edit", async (req, reply) => {
    const book = await prisma.book.findUnique({ where: { id: req.params.id } });
    if (!book) return reply.status(404).send("Not found");
    return reply.view(
      "book_edit.ejs",
      await withChrome(req, { book, error: null as string | null })
    );
  });

  app.post<{ Params: { id: string } }>("/books/:id/edit", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      const book = await prisma.book.findUnique({ where: { id: req.params.id } });
      return reply.view(
        "book_edit.ejs",
        await withChrome(req, {
          book,
          error: parsed.error.issues.map((i) => i.message).join(", "),
        })
      );
    }
    const d = parsed.data;

    // Build the Kindle ASIN patch separately so we can validate
    // before the main update. Empty input clears the value (and
    // its provenance flag); a non-empty input must normalize.
    let kindleAsinPatch:
      | { kindleAsin: string | null; kindleAsinSource: string | null }
      | null = null;
    const rawAsin = d.kindleAsin?.trim() ?? "";
    if (rawAsin === "") {
      kindleAsinPatch = { kindleAsin: null, kindleAsinSource: null };
    } else {
      const normalized = normalizeAsin(rawAsin);
      if (!normalized) {
        const book = await prisma.book.findUnique({ where: { id: req.params.id } });
        return reply.view(
          "book_edit.ejs",
          await withChrome(req, {
            book,
            error: "Kindle ASIN must be 10 alphanumeric characters (e.g. B07ZPC9QD4).",
          })
        );
      }
      kindleAsinPatch = { kindleAsin: normalized, kindleAsinSource: "manual" };
    }

    const updated = await prisma.book.update({
      where: { id: req.params.id },
      data: {
        title: d.title,
        authors: d.authors
          ? d.authors.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        primaryAuthor:
          (d.authors
            ? d.authors.split(",").map((s) => s.trim()).filter(Boolean)[0]
            : null) ?? null,
        publisher: blankToNull(d.publisher),
        publishedAt: blankToNull(d.publishedAt),
        isbn13: blankToNull(d.isbn13),
        thumbnailUrl: blankToNull(d.thumbnailUrl),
        seriesName: blankToNull(d.seriesName),
        seriesPosition: d.seriesPosition.trim()
          ? Number.parseFloat(d.seriesPosition.trim()) || null
          : null,
        source: "manual",
        ...kindleAsinPatch,
      },
    });
    void audit({
      userId: user.id,
      action: "update",
      entity: "book",
      entityId: updated.id,
      details: { fields: Object.keys(d), kindleAsin: kindleAsinPatch?.kindleAsin ?? null },
    });
    return reply.redirect(`/books/${updated.id}`);
  });

  // Explicit user action to clear the cooldown stamp and let the
  // next durable write re-fetch from Open Library. Used when a user
  // has cleared a wrong ASIN and now wants OL to try again — without
  // this, the cooldown would block the next attempt for up to 7
  // days.
  app.post<{ Params: { id: string } }>(
    "/books/:id/retry-kindle-lookup",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const book = await prisma.book.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!book) return reply.status(404).send("Not found");
      await prisma.book.update({
        where: { id: book.id },
        data: { kindleAsinAttemptedAt: null },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: book.id,
        details: { kindleAsinRetry: true },
      });
      // Schedule a fresh enrichment now that the cooldown is cleared.
      scheduleKindleAsinEnrichment(reply, book.id);
      return reply.redirect(`/books/${book.id}/edit`);
    }
  );

  // Re-fetch metadata from Google Books / Open Library and fill in any
  // fields that are currently null. Skipped for source: 'manual' books
  // unless ?force=1 is set, so user-curated overrides aren't clobbered.
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/books/:id/refetch",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const book = await prisma.book.findUnique({ where: { id: req.params.id } });
      if (!book) return reply.status(404).send("Not found");
      if (!book.isbn13)
        return reply.status(400).send("Book has no ISBN-13 — refetch needs one.");
      const force = req.query.force === "1" || req.query.force === "true";
      if (book.source === "manual" && !force) {
        return reply.redirect(`/books/${book.id}?refetched=skipped`);
      }
      const { lookupByIsbn } = await import("../../shared/metadata.js");
      const fetched = await lookupByIsbn(book.isbn13);
      if (!fetched) return reply.redirect(`/books/${book.id}?refetched=miss`);
      const meta = fetched;

      // Conservative merge: only overwrite null/empty fields unless force
      // is set. Authors[] is treated as needing repair when empty.
      const data: Record<string, unknown> = {};
      function fill(field: "title" | "publisher" | "publishedAt" | "thumbnailUrl" | "isbn10", current: unknown) {
        if (force || current === null || current === undefined || current === "") {
          const v = meta[field];
          if (v !== undefined && v !== null && v !== "") data[field] = v;
        }
      }
      fill("title", book.title);
      if (force || book.authors.length === 0) {
        if (meta.authors.length > 0) {
          data.authors = meta.authors;
          data.primaryAuthor = meta.authors[0];
        }
      }
      fill("publisher", book.publisher);
      fill("publishedAt", book.publishedAt);
      fill("thumbnailUrl", book.thumbnailUrl);
      fill("isbn10", book.isbn10);

      if (Object.keys(data).length > 0) {
        await prisma.book.update({ where: { id: book.id }, data });
        void audit({
          userId: user.id,
          action: "update",
          entity: "book",
          entityId: book.id,
          details: {
            refetched: true,
            force,
            fields: Object.keys(data),
          },
        });
      }
      // Refetch is a durable Book write — schedule ASIN enrichment.
      // Manual ASINs are protected by the atomic claim's source guard,
      // and the cooldown column prevents repeat OL hits if the user
      // re-clicks refetch within a week.
      scheduleKindleAsinEnrichment(reply, book.id);
      return reply.redirect(
        `/books/${book.id}?refetched=${Object.keys(data).length > 0 ? "ok" : "nochange"}`
      );
    }
  );
}
