import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { findOrCreateShelf } from "../../shared/shelves.js";
import { CONDITIONS, EDITIONS } from "../../shared/picklists.js";
import { getCurrentLibrary, requireUser } from "./_helpers.js";

const ACTIONS = ["add-shelf", "remove-shelf", "set-edition", "set-condition", "set-series", "trash"] as const;

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
    } else if (action === "set-series") {
      // Bulk-tag selected copies with a series name + auto-number their
      // seriesPosition by the order they appear in copyIds (which is
      // the DOM checkbox order — i.e. the visual order on /library at
      // the time of submit). Field lives on Book, so we update each
      // distinct bookId independently.
      const name = trimmed || null;
      const copies = await prisma.physicalCopy.findMany({
        where: { id: { in: ownedIds } },
        select: { id: true, bookId: true },
      });
      // Preserve the user's selection order. Map id → first index.
      const orderIndex = new Map<string, number>();
      copyIds.forEach((id, i) => {
        if (!orderIndex.has(id)) orderIndex.set(id, i);
      });
      // Distinct bookIds in selection order.
      const seenBookIds = new Set<string>();
      const orderedBookIds: string[] = [];
      copies
        .map((c) => ({ ...c, idx: orderIndex.get(c.id) ?? Infinity }))
        .sort((a, b) => a.idx - b.idx)
        .forEach((c) => {
          if (!seenBookIds.has(c.bookId)) {
            seenBookIds.add(c.bookId);
            orderedBookIds.push(c.bookId);
          }
        });
      // Apply: when a name was provided, number them 1..N. When name is
      // blank, treat as "clear series" — null both fields.
      for (let i = 0; i < orderedBookIds.length; i++) {
        await prisma.book.update({
          where: { id: orderedBookIds[i] },
          data: name
            ? { seriesName: name, seriesPosition: i + 1 }
            : { seriesName: null, seriesPosition: null },
        });
      }
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: orderedBookIds.join(","),
        details: {
          bulk: "set-series",
          name,
          count: orderedBookIds.length,
        },
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
