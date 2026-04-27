import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

const PAGE_SIZE = 100;

export async function auditRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { page?: string } }>("/audit", async (req, reply) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: PAGE_SIZE,
        skip,
      }),
      prisma.auditLog.count(),
    ]);
    const userIds = Array.from(new Set(rows.map((r) => r.userId).filter((x): x is string => Boolean(x))));
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const usersById = new Map(users.map((u) => [u.id, u]));
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return reply.view(
      "audit.ejs",
      await withChrome(req, { rows, usersById, page, totalPages, total })
    );
  });
}
