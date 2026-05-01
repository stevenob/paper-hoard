import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { requireUser, withChrome } from "./_helpers.js";

export async function trophiesRoutes(app: FastifyInstance) {
  app.get("/trophies", async (req, reply) => {
    const trophies = await prisma.trophy.findMany({
      include: { book: true, requestedBy: true, library: true },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return reply.view("trophies.ejs", await withChrome(req, { trophies }));
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const removed = await prisma.trophy.delete({ where: { id: req.params.id } }).catch(() => null);
    if (removed) {
      void audit({
        userId: user.id,
        action: "delete",
        entity: "trophy",
        entityId: removed.id,
        details: { bookId: removed.bookId, libraryId: removed.libraryId },
      });
    }
    return reply.redirect("/trophies");
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/defer", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.trophy
      .update({ where: { id: req.params.id }, data: { status: "deferred" } })
      .catch(() => null);
    void audit({
      userId: user.id,
      action: "update",
      entity: "trophy",
      entityId: req.params.id,
      details: { status: "deferred" },
    });
    return reply.redirect("/trophies");
  });

  app.post<{ Params: { id: string } }>("/trophies/:id/activate", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.trophy
      .update({ where: { id: req.params.id }, data: { status: "active" } })
      .catch(() => null);
    void audit({
      userId: user.id,
      action: "update",
      entity: "trophy",
      entityId: req.params.id,
      details: { status: "active" },
    });
    return reply.redirect("/trophies");
  });
}
