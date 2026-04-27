import type { FastifyInstance } from "fastify";
import {
  buildLoginUrl,
  clearSession,
  clearStateCookie,
  completeLogin,
  ForbiddenError,
  isOAuthConfigured,
  newState,
  readStateCookie,
  setSession,
  setStateCookie,
} from "../auth.js";
import { logger } from "../../shared/logger.js";

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/login", async (req, reply) => {
    if (!isOAuthConfigured()) {
      return reply.status(503).send({
        error:
          "Discord login is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and WEB_BASE_URL.",
      });
    }
    const state = newState();
    setStateCookie(reply, state);
    return reply.redirect(buildLoginUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/discord/callback",
    async (req, reply) => {
      const { code, state, error, error_description } = req.query;
      if (error) {
        clearStateCookie(reply);
        return reply
          .status(400)
          .send(`Discord login failed: ${error_description || error}`);
      }
      if (!code || !state) {
        clearStateCookie(reply);
        return reply.status(400).send("Missing code or state.");
      }
      const expected = readStateCookie(req);
      clearStateCookie(reply);
      if (!expected || expected !== state) {
        return reply.status(400).send("Invalid OAuth state. Try logging in again.");
      }
      try {
        const { userId } = await completeLogin(code);
        setSession(reply, userId);
        return reply.redirect("/");
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply.status(403).send(err.message);
        }
        logger.error({ err }, "OAuth callback failed");
        return reply.status(500).send("Login failed. Check server logs.");
      }
    }
  );

  app.post("/auth/logout", async (_req, reply) => {
    clearSession(reply);
    return reply.redirect("/");
  });
}
