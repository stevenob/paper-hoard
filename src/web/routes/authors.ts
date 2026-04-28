import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { resolveAuthorSlug } from "../../shared/authors.js";
import { getCurrentLibrary, withChrome } from "./_helpers.js";

export async function authorRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>("/authors/:slug", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(404).send("No library");
    const match = await resolveAuthorSlug(library.id, req.params.slug);
    if (!match) return reply.status(404).send("Unknown author");

    const copies = await prisma.physicalCopy.findMany({
      where: {
        libraryId: library.id,
        deletedAt: null,
        book: { primaryAuthor: { in: match.matchingNames } },
      },
      include: { book: true, shelves: { include: { shelf: true } } },
      orderBy: [{ book: { title: "asc" } }, { addedAt: "desc" }],
    });

    const bookIds = Array.from(new Set(copies.map((c) => c.bookId)));
    const [completions, trophies] = await Promise.all([
      bookIds.length
        ? prisma.completion.findMany({
            where: { libraryId: library.id, bookId: { in: bookIds } },
            include: { user: true, book: true },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      bookIds.length
        ? prisma.trophy.findMany({
            where: { libraryId: library.id, bookId: { in: bookIds } },
            include: { book: true, requestedBy: true },
          })
        : Promise.resolve([]),
    ]);

    return reply.view(
      "author.ejs",
      await withChrome(req, {
        author: match.canonical,
        slug: req.params.slug,
        copies,
        completions,
        trophies,
      })
    );
  });
}
