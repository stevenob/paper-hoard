import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function tagRoutes(app: FastifyInstance) {
  app.get("/tags", async (req, reply) => {
    const tags = await prisma.tag.findMany({
      include: { _count: { select: { books: true } } },
      orderBy: { name: "asc" },
    });
    return reply.view("tags.ejs", await withChrome(req, { tags }));
  });

  app.get<{ Params: { slug: string } }>("/tags/:slug", async (req, reply) => {
    const tag = await prisma.tag.findUnique({
      where: { slug: req.params.slug },
      include: {
        books: {
          include: {
            book: {
              include: {
                physicalCopies: { take: 1 },
                trophies: { take: 1 },
              },
            },
          },
        },
      },
    });
    if (!tag) return reply.status(404).send("Tag not found");
    return reply.view("tag.ejs", await withChrome(req, { tag }));
  });
}
