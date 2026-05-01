import type { FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "../../shared/db.js";
import { env } from "../../shared/env.js";
import { audit } from "../../shared/audit.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

export async function trashRoutes(app: FastifyInstance) {
  app.get("/trash", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const where = library
      ? { libraryId: library.id, deletedAt: { not: null } }
      : { deletedAt: { not: null } };
    const copies = await prisma.physicalCopy.findMany({
      where,
      include: { book: true, addedBy: true },
      orderBy: { deletedAt: "desc" },
    });
    // Stats: how many will auto-purge in the next 7 days. The sweeper deletes
    // anything > 30 days old; ≤7 days remaining means deletedAt > 23 days old.
    const sevenDayThreshold = new Date(Date.now() - 23 * 24 * 60 * 60 * 1000);
    const purgesThisWeek = copies.filter(
      (c) => c.deletedAt && new Date(c.deletedAt).getTime() < sevenDayThreshold.getTime()
    ).length;
    return reply.view(
      "trash.ejs",
      await withChrome(req, { copies, purgesThisWeek, autoPurgeAfterDays: 30 })
    );
  });

  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/restore",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const copy = await prisma.physicalCopy.findUnique({
        where: { id: req.params.id },
      });
      if (!copy) return reply.redirect("/trash");
      if (copy.deletedAt) {
        await prisma.physicalCopy.update({
          where: { id: copy.id },
          data: { deletedAt: null },
        });
        void audit({
          userId: user.id,
          action: "update",
          entity: "physicalCopy",
          entityId: copy.id,
          details: { restored: true },
        });
      }
      // Clear any pending undo cookie since the user took explicit action.
      reply.clearCookie("ph_undo", { path: "/" });
      const referer = req.headers.referer ?? `/library/copy/${copy.id}`;
      return reply.redirect(referer);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/hard-delete",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const copy = await prisma.physicalCopy.findUnique({
        where: { id: req.params.id },
      });
      if (!copy) return reply.redirect("/trash");
      if (copy.coverPath) {
        await fs
          .unlink(path.join(path.resolve(env.UPLOADS_DIR), copy.coverPath))
          .catch(() => undefined);
      }
      await prisma.physicalCopy
        .delete({ where: { id: copy.id } })
        .catch(() => undefined);
      void audit({
        userId: user.id,
        action: "delete",
        entity: "physicalCopy",
        entityId: copy.id,
        details: { hard: true },
      });
      return reply.redirect("/trash");
    }
  );
}

/**
 * Sweep soft-deleted copies older than 30 days. Called once at web boot,
 * then daily. Deleting the row removes any uploaded cover via FK cleanup
 * on related records, but the file on disk is removed here too.
 */
export async function sweepDeletedCopies() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const stale = await prisma.physicalCopy.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, coverPath: true },
  });
  for (const copy of stale) {
    if (copy.coverPath) {
      await fs
        .unlink(path.join(path.resolve(env.UPLOADS_DIR), copy.coverPath))
        .catch(() => undefined);
    }
    await prisma.physicalCopy.delete({ where: { id: copy.id } }).catch(() => undefined);
  }
  return stale.length;
}
