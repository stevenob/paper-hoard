import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../shared/env.js";
import { exportLibraryCsv, exportLibraryJson } from "./_exports.js";
import { runBackup } from "./_auto-backup.js";
import { getCurrentLibrary, requireUser } from "./_helpers.js";

export async function exportRoutes(app: FastifyInstance) {
  app.get("/library/export.csv", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(400).send("No library");
    const csv = await exportLibraryCsv(library.id);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="paperhoard-${stamp}.csv"`
    );
    return reply.send(csv);
  });

  app.get("/library/export.json", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(400).send("No library");
    const data = await exportLibraryJson(library.id);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="paperhoard-${stamp}.json"`
    );
    return reply.send(data);
  });

  // Manually trigger a backup write (for testing / on-demand backups).
  app.post("/library/backup-now", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const written = await runBackup();
    return reply.send({ ok: true, written, dir: path.resolve(env.BACKUPS_DIR) });
  });

  // List existing backups for the current library so /about can show
  // status and recent backup timestamps.
  app.get("/library/backups.json", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.send({ backups: [] });
    const dir = path.resolve(env.BACKUPS_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return reply.send({ backups: [], dirMissing: true });
    }
    const safeName = (library.publicSlug ?? library.id).replace(/[^a-zA-Z0-9_-]/g, "");
    const matches = entries.filter(
      (n) => n.startsWith(`paperhoard-${safeName}-`) && n.endsWith(".json")
    );
    const stats = await Promise.all(
      matches.map(async (name) => {
        const full = path.join(dir, name);
        try {
          const st = await fs.stat(full);
          return { name, size: st.size, mtime: st.mtime.toISOString() };
        } catch {
          return null;
        }
      })
    );
    const backups = stats
      .filter((s): s is { name: string; size: number; mtime: string } => s !== null)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    return reply.send({ backups, dir });
  });
}
