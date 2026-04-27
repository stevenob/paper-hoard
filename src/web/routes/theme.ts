import type { FastifyInstance } from "fastify";

const THEME_COOKIE = "ph_theme";
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function themeRoutes(app: FastifyInstance) {
  app.post("/theme/toggle", async (req, reply) => {
    const current = req.cookies[THEME_COOKIE];
    const next = current === "dark" ? "light" : "dark";
    reply.setCookie(THEME_COOKIE, next, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: ONE_YEAR,
    });
    const back = (req.headers.referer as string | undefined) ?? "/";
    try {
      const u = new URL(back);
      return reply.redirect(u.pathname + u.search);
    } catch {
      return reply.redirect("/");
    }
  });
}
