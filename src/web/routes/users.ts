import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

export async function usersRoutes(app: FastifyInstance) {
  app.get("/users", async (req, reply) => {
    const memberships = await prisma.membership.findMany({
      include: { user: true, library: true },
      orderBy: { createdAt: "asc" },
    });
    return reply.view("users.ejs", await withChrome(req, { memberships }));
  });
}
