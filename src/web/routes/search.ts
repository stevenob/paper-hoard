import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return reply.view("search.ejs", await withChrome(req, { q, books: [] }));

    const books = await prisma.book.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { authors: { has: q } },
          { isbn13: { equals: q.replace(/[^0-9]/g, "") } },
        ],
      },
      include: {
        physicalCopies: { include: { library: true }, take: 5 },
        trophies: { include: { library: true } },
        completions: { include: { user: true }, take: 5 },
      },
      take: 30,
    });
    return reply.view("search.ejs", await withChrome(req, { q, books }));
  });
}