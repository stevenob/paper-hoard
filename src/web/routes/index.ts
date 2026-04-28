import type { FastifyInstance } from "fastify";
import { homeRoutes } from "./home.js";
import { libraryRoutes } from "./library.js";
import { trophiesRoutes } from "./trophies.js";
import { completionsRoutes } from "./completions.js";
import { usersRoutes } from "./users.js";
import { scanRoutes } from "./scan.js";
import { authRoutes } from "./auth.js";
import { copyRoutes } from "./copy.js";
import { bookRoutes } from "./book.js";
import { searchRoutes } from "./search.js";
import { aboutRoutes } from "./about.js";
import { auditRoutes } from "./audit.js";
import { importRoutes } from "./import.js";
import { themeRoutes } from "./theme.js";
import { shareRoutes } from "./share.js";
import { shelvesRoutes } from "./shelves.js";

export async function registerRoutes(app: FastifyInstance) {
  await authRoutes(app);
  await themeRoutes(app);
  await shareRoutes(app);
  await homeRoutes(app);
  await libraryRoutes(app);
  await trophiesRoutes(app);
  await completionsRoutes(app);
  await usersRoutes(app);
  await scanRoutes(app);
  await copyRoutes(app);
  await bookRoutes(app);
  await searchRoutes(app);
  await aboutRoutes(app);
  await auditRoutes(app);
  await importRoutes(app);
  await shelvesRoutes(app);
}
