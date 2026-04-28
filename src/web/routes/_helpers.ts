import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../shared/db.js";
import { authorSlug } from "../../shared/authors.js";
import { getCurrentUser, isOAuthConfigured } from "../auth.js";

export async function getActiveUser(req: FastifyRequest) {
  return getCurrentUser(req);
}

export async function getOnlyLibrary() {
  // V1 uses a single household library. Pick the first one if any exist.
  return prisma.library.findFirst({ orderBy: { createdAt: "asc" } });
}

/**
 * Returns the library for the logged-in user (their first membership), falling
 * back to the only library when not logged in (read-only views).
 */
export async function getCurrentLibrary(req: FastifyRequest) {
  const user = await getCurrentUser(req);
  if (user) {
    const m = await prisma.membership.findFirst({
      where: { userId: user.id },
      include: { library: true },
      orderBy: { createdAt: "asc" },
    });
    if (m) return m.library;
  }
  return getOnlyLibrary();
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await getCurrentUser(req);
  if (!user) {
    reply.status(401).send({ error: "Login required." });
    return null;
  }
  return user;
}

export async function withChrome<T extends Record<string, unknown>>(
  req: FastifyRequest,
  ctx: T
) {
  const [activeUser, users, library] = await Promise.all([
    getCurrentUser(req),
    prisma.user.findMany({ orderBy: { displayName: "asc" } }),
    getCurrentLibrary(req),
  ]);
  const themeCookie = req.cookies["ph_theme"];
  const theme = themeCookie === "dark" || themeCookie === "light" ? themeCookie : "auto";
  return {
    ...ctx,
    activeUser,
    users,
    library,
    oauthConfigured: isOAuthConfigured(),
    theme,
    authorSlug,
  };
}

export type RouteRegistrar = (app: FastifyInstance) => Promise<void> | void;
