import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { findOrCreateShelf } from "../../shared/shelves.js";
import { CONDITIONS, EDITIONS } from "../../shared/picklists.js";
import { getCurrentLibrary, requireUser } from "./_helpers.js";

const ACTIONS = ["add-shelf", "remove-shelf", "set-edition", "set-condition", "trash"] as const;

const bulkSchema = z.object({
  action: z.enum(ACTIONS),
  value: z.string().max(200).optional().default(""),
  copyIds: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .pipe(z.array(z.string().min(1)).min(1).max(500)),
});

export async function bulkEditRoutes(app: FastifyInstance) {
  app.post("/library/bulk-edit", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(400).send("No library");

    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues.map((i) => i.message).join(", ") });
    }
    const { action, value, copyIds } = parsed.data;

    // Scope every action to copies the user's library actually owns.
    const owned = await prisma.physicalCopy.findMany({
      where: { id: { in: copyIds }, libraryId: library.id, deletedAt: null },
      select: { id: true },
    });
    const ownedIds = owned.map((c) => c.id);
    if (ownedIds.length === 0) return reply.redirect("/library");

    const trimmed = value.trim();

    if (action === "add-shelf") {
      if (!trimmed) return reply.status(400).send({ error: "Shelf name required" });
      const shelf = await findOrCreateShelf(library.id, trimmed);
      // Skip rows that are already on the shelf — composite primary key
      // would otherwise conflict.
      const existing = await prisma.shelfCopy.findMany({
        where: { shelfId: shelf.id, copyId: { in: ownedIds } },
        select: { copyId: true },
      });
      const existingSet = new Set(existing.map((s) => s.copyId));
      const toAdd = ownedIds.filter((id) => !existingSet.has(id));
      if (toAdd.length > 0) {
        await prisma.shelfCopy.createMany({
          data: toAdd.map((copyId) => ({ shelfId: shelf.id, copyId })),
        });
      }
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: ownedIds.join(","),
        details: { bulk: "add-shelf", shelf: shelf.name, count: toAdd.length },
      });
    } else if (action === "remove-shelf") {
      if (!trimmed) return reply.status(400).send({ error: "Shelf name required" });
      const shelf = await prisma.shelf.findFirst({
        where: { libraryId: library.id, name: { equals: trimmed, mode: "insensitive" } },
      });
      if (shelf) {
        await prisma.shelfCopy.deleteMany({
          where: { shelfId: shelf.id, copyId: { in: ownedIds } },
        });
      }
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: ownedIds.join(","),
        details: { bulk: "remove-shelf", shelf: trimmed, count: ownedIds.length },
      });
    } else if (action === "set-edition") {
      if (trimmed && !(EDITIONS as readonly string[]).includes(trimmed)) {
        return reply.status(400).send({ error: "Invalid edition" });
      }
      await prisma.physicalCopy.updateMany({
        where: { id: { in: ownedIds } },
        data: { edition: trimmed || null },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: ownedIds.join(","),
        details: { bulk: "set-edition", value: trimmed || null, count: ownedIds.length },
      });
    } else if (action === "set-condition") {
      if (trimmed && !(CONDITIONS as readonly string[]).includes(trimmed)) {
        return reply.status(400).send({ error: "Invalid condition" });
      }
      await prisma.physicalCopy.updateMany({
        where: { id: { in: ownedIds } },
        data: { condition: trimmed || null },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: ownedIds.join(","),
        details: { bulk: "set-condition", value: trimmed || null, count: ownedIds.length },
      });
    } else if (action === "trash") {
      await prisma.physicalCopy.updateMany({
        where: { id: { in: ownedIds } },
        data: { deletedAt: new Date() },
      });
      void audit({
        userId: user.id,
        action: "delete",
        entity: "physicalCopy",
        entityId: ownedIds.join(","),
        details: { bulk: "trash", soft: true, count: ownedIds.length },
      });
    }

    const referer = req.headers.referer ?? "/library";
    return reply.redirect(referer);
  });
}
