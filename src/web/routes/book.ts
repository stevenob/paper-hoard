import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { isStale, refreshOpenLibraryRatings } from "../../shared/openlibrary-ratings.js";
import { requireUser, withChrome } from "./_helpers.js";

const editSchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.string().max(1000).optional().default(""),
  publisher: z.string().max(200).optional().default(""),
  publishedAt: z.string().max(50).optional().default(""),
  isbn13: z.string().max(13).optional().default(""),
  thumbnailUrl: z.string().max(2000).optional().default(""),
});

function blankToNull(v: string | undefined): string | null {
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function bookRoutes(app: FastifyInstance) {
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
