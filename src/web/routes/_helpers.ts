import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../shared/db.js";

const ACTIVE_USER_COOKIE = "ph_active_user";

export function getActiveUserId(req: FastifyRequest): string | null {
  return req.cookies[ACTIVE_USER_COOKIE] ?? null;
}

export async function getActiveUser(req: FastifyRequest) {
  const id = getActiveUserId(req);
  if (!id) return null;
  return prisma.user.findUnique({ where: { id } });
}

export function setActiveUser(reply: FastifyReply, userId: string) {
  reply.setCookie(ACTIVE_USER_COOKIE, userId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function clearActiveUser(reply: FastifyReply) {
  reply.clearCookie(ACTIVE_USER_COOKIE, { path: "/" });
}

export async function getOnlyLibrary() {
  // V1 web UI assumes a single household library. Pick the first one if any exist.
  return prisma.library.findFirst({ orderBy: { createdAt: "asc" } });
}

export async function withChrome<T extends Record<string, unknown>>(
  req: FastifyRequest,
  ctx: T
): Promise<T & { activeUser: Awaited<ReturnType<typeof getActiveUser>>; users: Awaited<ReturnType<typeof prisma.user.findMany>>; library: Awaited<ReturnType<typeof getOnlyLibrary>> }> {
  const [activeUser, users, library] = await Promise.all([
    getActiveUser(req),
    prisma.user.findMany({ orderBy: { displayName: "asc" } }),
    getOnlyLibrary(),
  ]);
  return { ...ctx, activeUser, users, library };
}

export type RouteRegistrar = (app: FastifyInstance) => Promise<void> | void;
