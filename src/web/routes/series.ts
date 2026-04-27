import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function seriesRoutes(app: FastifyInstance) {
  app.get("/series", async (req, reply) => {
    const grouped = await prisma.book.groupBy({
      by: ["seriesName"],
      where: { seriesName: { not: null } },
      _count: true,
      orderBy: { seriesName: "asc" },
    });
    const series = grouped.map((g) => ({ name: g.seriesName!, count: g._count }));
    return reply.view("series_list.ejs", await withChrome(req, { series }));
  });

  app.get<{ Params: { name: string } }>("/series/:name", async (req, reply) => {
    const name = decodeURIComponent(req.params.name);
    const books = await prisma.book.findMany({
      where: { seriesName: name },
      include: {
        physicalCopies: { take: 1 },
        trophies: { take: 1 },
      },
      orderBy: [
        { seriesPosition: { sort: "asc", nulls: "last" } },
        { title: "asc" },
      ],
    });
    if (books.length === 0) return reply.status(404).send("No such series");
    return reply.view("series.ejs", await withChrome(req, { name, books }));
  });
}
