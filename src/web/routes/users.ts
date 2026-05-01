import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { getCurrentLibrary, withChrome } from "./_helpers.js";

export async function usersRoutes(app: FastifyInstance) {
  app.get("/users", async (req, reply) => {
    const memberships = await prisma.membership.findMany({
      include: { user: true, library: true },
      orderBy: { createdAt: "asc" },
    });
    // Per-user copies-added contribution count, scoped to the active
    // library when present so per-library views stay honest.
    const library = await getCurrentLibrary(req);
    const grouped = await prisma.physicalCopy.groupBy({
      by: ["addedByUserId"],
      where: library ? { libraryId: library.id, deletedAt: null } : { deletedAt: null },
      _count: { _all: true },
    });
    const copiesAdded = new Map<string, number>();
    for (const g of grouped) copiesAdded.set(g.addedByUserId, g._count._all);
    const memberCount = new Set(memberships.map((m) => m.userId)).size;
    const libraryCount = new Set(memberships.map((m) => m.libraryId)).size;
    return reply.view(
      "users.ejs",
      await withChrome(req, {
        memberships,
        copiesAddedByUserId: Object.fromEntries(copiesAdded),
        memberCount,
        libraryCount,
      })
    );
  });
}
