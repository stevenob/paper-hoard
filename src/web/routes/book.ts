import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function bookRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/books/:id", async (req, reply) => {
    const book = await prisma.book.findUnique({ where: { id: req.params.id } });
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
}