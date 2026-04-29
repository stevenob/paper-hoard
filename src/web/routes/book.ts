import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";
import { ensureMembership } from "../../shared/repo.js";
import { EDITIONS } from "../../shared/picklists.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const editSchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.string().max(1000).optional().default(""),
  publisher: z.string().max(200).optional().default(""),
  publishedAt: z.string().max(50).optional().default(""),
  isbn13: z.string().max(13).optional().default(""),
  thumbnailUrl: z.string().max(2000).optional().default(""),
});

const newSchema = editSchema.extend({
  edition: z.string().max(50).optional().default(""),
});

function blankToNull(v: string | undefined): string | null {
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function bookRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, string> }>("/books/new", async (req, reply) => {
    const prefill = {
      title: typeof req.query.title === "string" ? req.query.title.slice(0, 500) : "",
      authors: typeof req.query.authors === "string" ? req.query.authors.slice(0, 1000) : "",
      publisher: typeof req.query.publisher === "string" ? req.query.publisher.slice(0, 200) : "",
      publishedAt: typeof req.query.publishedAt === "string" ? req.query.publishedAt.slice(0, 50) : "",
      isbn13: typeof req.query.isbn === "string" ? req.query.isbn.replace(/[^0-9Xx]/g, "").slice(0, 13) : "",
    };
    return reply.view(
      "book_new.ejs",
      await withChrome(req, {
        prefill,
        editions: EDITIONS,
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
      return reply.view(
        "book_new.ejs",
        await withChrome(req, {
          prefill: req.body ?? {},
          editions: EDITIONS,
          error: parsed.error.issues.map((i) => i.message).join(", "),
        })
      );
    }
    const d = parsed.data;
    const isbn13 = d.isbn13.replace(/[^0-9Xx]/g, "").trim() || null;

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
    };
    if (existing) {
      book = await prisma.book.update({
        where: { id: existing.id },
        data: sharedFields,
      });
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
      },
    });
    void audit({
      userId: user.id,
      action: "create",
      entity: "physicalCopy",
      entityId: copy.id,
      details: { bookId: book.id, source: "manual-form" },
    });

    return reply.redirect(`/library/copy/${copy.id}`);
  });

  app.get<{ Params: { id: string } }>("/books/:id", async (req, reply) => {
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
      await withChrome(req, { book, copies, completions, trophies, shelves })
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
    const updated = await prisma.book.update({
      where: { id: req.params.id },
      data: {
        title: d.title,
        authors: d.authors
          ? d.authors.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        publisher: blankToNull(d.publisher),
        publishedAt: blankToNull(d.publishedAt),
        isbn13: blankToNull(d.isbn13),
        thumbnailUrl: blankToNull(d.thumbnailUrl),
        source: "manual",
      },
    });
    void audit({
      userId: user.id,
      action: "update",
      entity: "book",
      entityId: updated.id,
      details: { fields: Object.keys(d) },
    });
    return reply.redirect(`/books/${updated.id}`);
  });
}
