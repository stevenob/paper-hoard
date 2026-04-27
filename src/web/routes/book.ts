import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { findOrCreateTag } from "../../shared/tags.js";
import { requireUser, withChrome } from "./_helpers.js";

const editSchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.string().max(1000).optional().default(""),
  publisher: z.string().max(200).optional().default(""),
  publishedAt: z.string().max(50).optional().default(""),
  isbn13: z.string().max(13).optional().default(""),
  thumbnailUrl: z.string().max(2000).optional().default(""),
  seriesName: z.string().max(200).optional().default(""),
  seriesPosition: z.string().optional().default(""),
});

const addTagSchema = z.object({
  name: z.string().min(1).max(64),
});

function blankToNull(v: string | undefined): string | null {
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function bookRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/books/:id", async (req, reply) => {
    const book = await prisma.book.findUnique({
      where: { id: req.params.id },
      include: { tags: { include: { tag: true } } },
    });
    if (!book) return reply.status(404).send("Not found");
    const [copies, completions, trophies] = await Promise.all([
      prisma.physicalCopy.findMany({
        where: { bookId: book.id },
        include: { addedBy: true, library: true },
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
    return reply.view(
      "book.ejs",
      await withChrome(req, { book, copies, completions, trophies })
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
    const positionNum = d.seriesPosition && d.seriesPosition.length > 0 ? Number(d.seriesPosition) : null;

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
        seriesName: blankToNull(d.seriesName),
        seriesPosition: positionNum && !isNaN(positionNum) ? positionNum : null,
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

  // ----- Tag attachment -----

  app.post<{ Params: { id: string } }>("/books/:id/tags", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = addTagSchema.safeParse(req.body);
    if (!parsed.success) return reply.redirect(`/books/${req.params.id}`);
    const tag = await findOrCreateTag(parsed.data.name).catch(() => null);
    if (!tag) return reply.redirect(`/books/${req.params.id}`);
    await prisma.bookTag.upsert({
      where: { bookId_tagId: { bookId: req.params.id, tagId: tag.id } },
      create: { bookId: req.params.id, tagId: tag.id },
      update: {},
    });
    return reply.redirect(`/books/${req.params.id}`);
  });

  app.post<{ Params: { id: string; tagId: string } }>(
    "/books/:id/tags/:tagId/delete",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      await prisma.bookTag
        .delete({
          where: { bookId_tagId: { bookId: req.params.id, tagId: req.params.tagId } },
        })
        .catch(() => undefined);
      return reply.redirect(`/books/${req.params.id}`);
    }
  );
}