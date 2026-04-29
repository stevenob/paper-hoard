import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../shared/env.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/db.js";
import { exportLibraryJson } from "./_exports.js";

const RETENTION_DAYS = 30;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function ensureBackupsDir(): Promise<string> {
  const dir = path.resolve(env.BACKUPS_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Run a JSON backup for every library in the database. Designed for the
 * single-household case but cleanly handles a future multi-library setup.
 *
 * Returns the list of files written (full absolute paths) for logging.
 */
export async function runBackup(): Promise<string[]> {
  const dir = await ensureBackupsDir();
  const libraries = await prisma.library.findMany({
    select: { id: true, name: true, publicSlug: true },
  });
  if (libraries.length === 0) return [];

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const written: string[] = [];

  for (const lib of libraries) {
    const data = await exportLibraryJson(lib.id);
    const safeName = (lib.publicSlug ?? lib.id).replace(/[^a-zA-Z0-9_-]/g, "");
    const file = path.join(dir, `paperhoard-${safeName}-${stamp}.json`);
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
    written.push(file);
  }
  return written;
}

/**
 * Drop backup files older than RETENTION_DAYS. Failure is non-fatal —
 * if the dir is missing or unreadable we log and move on.
 */
export async function pruneBackups(): Promise<number> {
  const dir = path.resolve(env.BACKUPS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("paperhoard-") || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * Schedule a backup at startup (after a short delay so app boot completes
 * before we hammer the DB) and once a day thereafter.
 */
export function scheduleAutoBackup(): void {
  async function tick() {
    try {
      const written = await runBackup();
      const pruned = await pruneBackups();
      if (written.length > 0 || pruned > 0) {
        logger.info({ written: written.length, pruned }, "Auto-backup complete");
      }
    } catch (err) {
      logger.warn({ err }, "Auto-backup failed");
    }
  }
  // Initial run after 60s — gives migrations / OL refreshes time to settle.
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), BACKUP_INTERVAL_MS).unref();
}
