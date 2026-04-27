import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function trophiesRoutes(app: FastifyInstance) {
  app.get("/trophies", async (req, reply) => {
    const trophies = await prisma.trophy.findMany({
      include: { book: true, requestedBy: true, library: true },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return reply.view("trophies.ejs", await withChrome(req, { trophies }));
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/delete", async (req, reply) => {
    await prisma.trophy.delete({ where: { id: req.params.id } }).catch(() => undefined);
    return reply.redirect("/trophies");
  });
}
