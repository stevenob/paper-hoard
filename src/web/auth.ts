import { request } from "undici";
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../shared/db.js";
import { getOAuthEnv } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import { ensureMembership, upsertLibrary, upsertUser } from "../shared/repo.js";

const SESSION_COOKIE = "ph_session";
const STATE_COOKIE = "ph_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const STATE_MAX_AGE = 60 * 10; // 10 min

export const REDIRECT_PATH = "/auth/discord/callback";

export function isOAuthConfigured(): boolean {
  return getOAuthEnv() !== null;
}

export function buildLoginUrl(state: string): string {
  const oauth = getOAuthEnv();
  if (!oauth) throw new Error("OAuth is not configured");
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", oauth.baseUrl + REDIRECT_PATH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "none");
  return url.toString();
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
}

interface DiscordGuildSummary {
  id: string;
  name: string;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse> {
  const oauth = getOAuthEnv();
  if (!oauth) throw new Error("OAuth is not configured");
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: oauth.baseUrl + REDIRECT_PATH,
  });
  const res = await request("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`Discord token exchange failed (${res.statusCode}): ${text}`);
  }
  return (await res.body.json()) as DiscordTokenResponse;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await request("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.statusCode >= 400) {
    throw new Error(`Discord /users/@me failed (${res.statusCode})`);
  }
  return (await res.body.json()) as DiscordUser;
}

export async function fetchDiscordGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
  const res = await request("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.statusCode >= 400) {
    throw new Error(`Discord /users/@me/guilds failed (${res.statusCode})`);
  }
  return (await res.body.json()) as DiscordGuildSummary[];
}

export async function completeLogin(code: string): Promise<{ userId: string; libraryId: string }> {
  const oauth = getOAuthEnv();
  if (!oauth) throw new Error("OAuth is not configured");

  const token = await exchangeCode(code);
  const [user, guilds] = await Promise.all([
    fetchDiscordUser(token.access_token),
    fetchDiscordGuilds(token.access_token),
  ]);

  // Find the first guild the user is in that's also in our allow-list.
  const matchingGuild =
    oauth.allowedGuildIds.length === 0
      ? guilds[0]
      : guilds.find((g) => oauth.allowedGuildIds.includes(g.id));
  if (!matchingGuild) {
    throw new ForbiddenError(
      "You are not a member of an authorized Discord server for this Paper Hoard."
    );
  }

  const displayName = user.global_name || user.username;
  const [dbUser, library] = await Promise.all([
    upsertUser(user.id, displayName),
    upsertLibrary(matchingGuild.id, matchingGuild.name),
  ]);
  await ensureMembership(dbUser.id, library.id);

  logger.info({ userId: dbUser.id, libraryId: library.id }, "user logged in via Discord OAuth");
  return { userId: dbUser.id, libraryId: library.id };
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// ---- session cookie helpers ----

export function setSession(reply: FastifyReply, userId: string) {
  reply.setCookie(SESSION_COOKIE, userId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    signed: true,
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function readSessionUserId(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  return result.valid ? result.value : null;
}

export async function getCurrentUser(req: FastifyRequest) {
  const id = readSessionUserId(req);
  if (!id) return null;
  return prisma.user.findUnique({ where: { id } });
}

// ---- state cookie helpers (CSRF) ----

export function newState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function setStateCookie(reply: FastifyReply, state: string) {
  reply.setCookie(STATE_COOKIE, state, {
    path: "/auth",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    signed: true,
    maxAge: STATE_MAX_AGE,
  });
}

export function readStateCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[STATE_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  return result.valid ? result.value : null;
}

export function clearStateCookie(reply: FastifyReply) {
  reply.clearCookie(STATE_COOKIE, { path: "/auth" });
}
