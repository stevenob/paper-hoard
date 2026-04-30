import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import view from "@fastify/view";
import ejs from "ejs";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { env } from "../shared/env.js";
import { logger } from "../shared/logger.js";
import { registerRoutes } from "./routes/index.js";

void logger;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the configured Fastify app without binding to a port. Used by
 * main() to listen for real and by tests to fastify.inject() requests.
 *
 * The `viewsRoot` and `publicRoot` overrides exist so tests run against
 * the source-tree views (src/web/views) instead of dist/ which only
 * exists after a build.
 */
export async function buildApp(opts: {
  viewsRoot?: string;
  publicRoot?: string;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(formbody);
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  await app.register(view, {
    engine: { ejs },
    root: opts.viewsRoot ?? path.join(__dirname, "views"),
    defaultContext: { appName: "Paper Hoard" },
  });
  await app.register(staticPlugin, {
    root: opts.publicRoot ?? path.join(__dirname, "public"),
    prefix: "/static/",
  });

  // Uploads (cover photos). Resolve relative to cwd so a relative
  // UPLOADS_DIR like ./data/uploads works in dev without configuration.
  const uploadsDir = path.resolve(env.UPLOADS_DIR);
  await fs.mkdir(uploadsDir, { recursive: true });
  await app.register(staticPlugin, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  await registerRoutes(app);
  return app;
}

async function main() {
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: env.WEB_PORT });
  app.log.info(
    { port: env.WEB_PORT, uploadsDir: path.resolve(env.UPLOADS_DIR) },
    "Paper Hoard web UI listening"
  );
}

// Only auto-start when this module is the entrypoint. Tests import
// buildApp directly without triggering listen().
const isEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Web UI failed to start", err);
    process.exit(1);
  });
}
