import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function homeRoutes(app: FastifyInstance) {
  app.get("/", async (req, reply) => {
    const [physicalCount, trophyCount, completionCount] = await Promise.all([
      prisma.physicalCopy.count(),
      prisma.trophy.count(),
      prisma.completion.count(),
    ]);
    return reply.view("home.ejs", await withChrome(req, { physicalCount, trophyCount, completionCount }));
  });

  app.get("/healthz", async () => ({ ok: true }));
}
