import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function libraryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/library", async (req, reply) => {
    const q = req.query.q?.trim();
    const copies = await prisma.physicalCopy.findMany({
      where: q
        ? {
            book: {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { authors: { has: q } },
              ],
            },
          }
        : undefined,
      include: { book: true, addedBy: true, library: true },
      orderBy: { addedAt: "desc" },
      take: 100,
    });
    return reply.view("library.ejs", await withChrome(req, { copies, q: q ?? "" }));
  });
}
