import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { clearActiveUser, setActiveUser, withChrome } from "./_helpers.js";

const newUserSchema = z.object({
  displayName: z.string().min(1).max(100),
  discordUserId: z.string().min(1).max(100),
});

const switchSchema = z.object({
  userId: z.string().min(1),
});

export async function usersRoutes(app: FastifyInstance) {
  app.get("/users", async (req, reply) => {
    return reply.view("users.ejs", await withChrome(req, { error: null as string | null }));
  });

  app.post("/users", async (req, reply) => {
    const parsed = newUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.view(
        "users.ejs",
        await withChrome(req, { error: parsed.error.issues.map((i) => i.message).join(", ") })
      );
    }
    const existing = await prisma.user.findUnique({
      where: { discordUserId: parsed.data.discordUserId },
    });
    if (existing) {
      return reply.view(
        "users.ejs",
        await withChrome(req, { error: "A user with that Discord ID already exists." })
      );
    }
    await prisma.user.create({ data: parsed.data });
    return reply.redirect("/users");
  });

  app.post("/users/switch", async (req, reply) => {
    const parsed = switchSchema.safeParse(req.body);
    if (!parsed.success) return reply.redirect("/users");
    const u = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (u) setActiveUser(reply, u.id);
    const back = safeBack(req.headers.referer);
    return reply.redirect(back);
  });

  app.post("/users/clear", async (req, reply) => {
    clearActiveUser(reply);
    const back = safeBack(req.headers.referer);
    return reply.redirect(back);
  });
}

function safeBack(referer: unknown): string {
  if (typeof referer !== "string" || referer.length === 0) return "/";
  try {
    const u = new URL(referer);
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
