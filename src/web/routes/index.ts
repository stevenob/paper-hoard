import type { FastifyInstance } from "fastify";
import { homeRoutes } from "./home.js";
import { libraryRoutes } from "./library.js";
import { trophiesRoutes } from "./trophies.js";
import { completionsRoutes } from "./completions.js";
import { usersRoutes } from "./users.js";
import { scanRoutes } from "./scan.js";
import { authRoutes } from "./auth.js";

export async function registerRoutes(app: FastifyInstance) {
  await authRoutes(app);
  await homeRoutes(app);
  await libraryRoutes(app);
  await trophiesRoutes(app);
  await completionsRoutes(app);
  await usersRoutes(app);
  await scanRoutes(app);
}
