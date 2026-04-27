import type { FastifyInstance } from "fastify";
import { homeRoutes } from "./home.js";
import { libraryRoutes } from "./library.js";
import { trophiesRoutes } from "./trophies.js";
import { completionsRoutes } from "./completions.js";
import { usersRoutes } from "./users.js";

export async function registerRoutes(app: FastifyInstance) {
  await homeRoutes(app);
  await libraryRoutes(app);
  await trophiesRoutes(app);
  await completionsRoutes(app);
  await usersRoutes(app);
}
