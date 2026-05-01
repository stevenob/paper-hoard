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
import { authorRoutes } from "./authors.js";
import { trashRoutes, sweepDeletedCopies } from "./trash.js";
import { statsRoutes } from "./stats.js";
import { bulkEditRoutes } from "./bulk-edit.js";
import { bookMergeRoutes } from "./book-merge.js";
import { exportRoutes } from "./exports.js";
import { labelRoutes } from "./labels.js";
import { lendingRoutes } from "./lending.js";
import { authorMergeRoutes } from "./author-merge.js";
import { scheduleAutoBackup } from "./_auto-backup.js";
import { logger } from "../../shared/logger.js";

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
  await authorRoutes(app);
  await trashRoutes(app);
  await statsRoutes(app);
  await bulkEditRoutes(app);
  await bookMergeRoutes(app);
  await exportRoutes(app);
  await labelRoutes(app);
  await lendingRoutes(app);
  await authorMergeRoutes(app);

  // Sweep soft-deleted copies older than 30 days at boot, then daily.
  void sweepDeletedCopies()
    .then((n) => n > 0 && logger.info({ swept: n }, "Hard-deleted stale copies"))
    .catch((err) => logger.warn({ err }, "Sweep failed"));
  setInterval(() => {
    void sweepDeletedCopies()
      .then((n) => n > 0 && logger.info({ swept: n }, "Hard-deleted stale copies"))
      .catch((err) => logger.warn({ err }, "Sweep failed"));
  }, 24 * 60 * 60 * 1000).unref();

  // Daily JSON backup of every library to BACKUPS_DIR with 30-day
  // retention. Application-consistent companion to the Postgres dataset
  // ZFS snapshot policy that already covers crash-consistency.
  scheduleAutoBackup();
}

