import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import staticPlugin from "@fastify/static";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../shared/env.js";
import { logger } from "../shared/logger.js";

void logger;
import { registerRoutes } from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(formbody);
  await app.register(view, {
    engine: { ejs },
    root: path.join(__dirname, "views"),
    defaultContext: { appName: "Paper Hoard" },
  });
  await app.register(staticPlugin, {
    root: path.join(__dirname, "public"),
    prefix: "/static/",
  });

  await registerRoutes(app);

  await app.listen({ host: "0.0.0.0", port: env.WEB_PORT });
  logger.info({ port: env.WEB_PORT }, "Paper Hoard web UI listening");
}

main().catch((err) => {
  logger.error({ err }, "Web UI failed to start");
  process.exit(1);
});
