import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { findOrCreateShelf } from "../../shared/shelves.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const editSchema = z.object({
  name: z.string().min(1).max(100),
  isOrdered: z.union([z.literal("on"), z.literal("")]).optional(),
});

export async function shelvesRoutes(app: FastifyInstance) {
  app.get("/shelves", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const realShelves = library
      ? await prisma.shelf.findMany({
          where: { libraryId: library.id },
          orderBy: [{ name: "asc" }],
          include: {
            copies: {
              include: {
                copy: {
                  include: { book: true },
                },
              },
              orderBy: [
                { position: { sort: "asc", nulls: "last" } },
                { copy: { addedAt: "desc" } },
              ],
              take: 30,
            },
            _count: { select: { copies: true } },
          },
        })
      : [];

    // ===== Series auto-rails (v3.5.34) =====
    // Every series the user owns at least one book in becomes a virtual
    // rail on this page. Same shape as a real shelf so the EJS view can
    // render them uniformly, but with `kind: "series"` so links can
    // route to /series?name=... instead of /shelves/:slug.
    const seriesCopies = library
      ? await prisma.physicalCopy.findMany({
          where: {
            libraryId: library.id,
            deletedAt: null,
            book: { seriesName: { not: null } },
          },
          include: { book: true },
          orderBy: { addedAt: "asc" },
        })
      : [];
    type SeriesGroup = {
      name: string;
      copies: typeof seriesCopies;
    };
    const seriesByName = new Map<string, SeriesGroup>();
    for (const c of seriesCopies) {
      const name = (c.book.seriesName ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let g = seriesByName.get(key);
      if (!g) {
        g = { name, copies: [] };
        seriesByName.set(key, g);
      }
      g.copies.push(c);
    }
    // Sort each group by seriesPosition asc; ties broken by addedAt asc.
    for (const g of seriesByName.values()) {
      g.copies.sort((a, b) => {
        const ap = a.book.seriesPosition ?? Number.POSITIVE_INFINITY;
        const bp = b.book.seriesPosition ?? Number.POSITIVE_INFINITY;
        if (ap !== bp) return ap - bp;
        return a.addedAt.getTime() - b.addedAt.getTime();
      });
    }

    // Reshape virtual series into the same union shape the view expects.
    type Rail = {
      kind: "shelf" | "series";
      name: string;
      slug: string; // for "view all" links
      isOrdered: boolean;
      tiles: Array<{
        copyId: string;
        coverPath: string | null;
        thumbnailUrl: string | null;
        title: string;
        primaryAuthor: string | null;
        position: number | null; // for the #N badge
      }>;
      total: number;
    };
    const shelfRails: Rail[] = realShelves.map((s) => ({
      kind: "shelf",
      name: s.name,
      slug: s.slug,
      isOrdered: s.isOrdered,
      tiles: s.copies.map((it) => ({
        copyId: it.copy.id,
        coverPath: it.copy.coverPath,
        thumbnailUrl: it.copy.book.thumbnailUrl,
        title: it.copy.book.title,
        primaryAuthor: it.copy.book.primaryAuthor,
        position: s.isOrdered ? it.position : null,
      })),
      total: s._count.copies,
    }));
    const seriesRails: Rail[] = Array.from(seriesByName.values()).map((g) => ({
      kind: "series",
      name: g.name,
      slug: g.name, // not a real slug — the view URL-encodes it for ?name=
      isOrdered: true,
      tiles: g.copies.slice(0, 30).map((c) => ({
        copyId: c.id,
        coverPath: c.coverPath,
        thumbnailUrl: c.book.thumbnailUrl,
        title: c.book.title,
        primaryAuthor: c.book.primaryAuthor,
        position: c.book.seriesPosition,
      })),
      total: g.copies.length,
    }));
    // Interleave shelves and series, alphabetical by name, case-insensitive.
    const rails = [...shelfRails, ...seriesRails].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    const totalOrganised = realShelves.reduce((acc, s) => acc + s._count.copies, 0);
    const orderedCount = realShelves.filter((s) => s.isOrdered).length;
    const seriesCount = seriesRails.length;

    return reply.view(
      "shelves.ejs",
      await withChrome(req, {
        rails,
        totalOrganised,
        orderedCount,
        seriesCount,
        shelfCount: realShelves.length,
      })
    );
  });

  app.get<{ Params: { slug: string } }>("/shelves/:slug", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    if (!library) return reply.status(404).send("No library yet");
    const shelf = await prisma.shelf.findUnique({
      where: { libraryId_slug: { libraryId: library.id, slug: req.params.slug } },
      include: {
        copies: {
          orderBy: shelf_copies_order_for(true),
          include: { copy: { include: { book: true, addedBy: true } } },
        },
      },
    });
    if (!shelf) return reply.status(404).send("Shelf not found");
    const items = [...shelf.copies];
    if (shelf.isOrdered) {
      items.sort((a, b) => (a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY));
    } else {
      items.sort((a, b) => a.copy.book.title.localeCompare(b.copy.book.title));
    }
    // v3.5.13: read/unread split. A copy counts as read when any user has
    // marked it as completed.
    const bookIds = items.map((it) => it.copy.bookId);
    const readBookIds = bookIds.length
      ? new Set(
          (
            await prisma.completion.findMany({
              where: { libraryId: library.id, bookId: { in: bookIds } },
              select: { bookId: true },
            })
          ).map((c) => c.bookId)
        )
      : new Set<string>();
    const readCount = items.filter((it) => readBookIds.has(it.copy.bookId)).length;
    const unreadCount = items.length - readCount;
    return reply.view(
      "shelf.ejs",
      await withChrome(req, { shelf, items, readCount, unreadCount })
    );
  });

  app.post<{ Params: { id: string } }>("/shelves/:id/edit", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return reply.redirect(`/shelves`);
    const updated = await prisma.shelf.update({
      where: { id: req.params.id },
      data: {
        name: parsed.data.name.trim(),
        isOrdered: parsed.data.isOrdered === "on",
      },
    });
    void audit({
      userId: user.id,
      action: "update",
      entity: "book",
      entityId: updated.id,
      details: { shelf: updated.name, isOrdered: updated.isOrdered },
    });
    return reply.redirect(`/shelves/${updated.slug}`);
  });

  app.post<{ Params: { id: string } }>("/shelves/:id/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.shelf.delete({ where: { id: req.params.id } }).catch(() => undefined);
    return reply.redirect("/shelves");
  });

  // Add a copy to a shelf (creating the shelf if name doesn't exist).
  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/shelves",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const library = await getCurrentLibrary(req);
      if (!library) return reply.redirect(`/library/copy/${req.params.id}`);
      const body = (req.body ?? {}) as { name?: string };
      if (!body.name || !body.name.trim()) {
        return reply.redirect(`/library/copy/${req.params.id}`);
      }
      const shelf = await findOrCreateShelf(library.id, body.name).catch(() => null);
      if (!shelf) return reply.redirect(`/library/copy/${req.params.id}`);
      await prisma.shelfCopy.upsert({
        where: { shelfId_copyId: { shelfId: shelf.id, copyId: req.params.id } },
        create: { shelfId: shelf.id, copyId: req.params.id },
        update: {},
      });
      return reply.redirect(`/library/copy/${req.params.id}`);
    }
  );

  app.post<{ Params: { id: string; shelfId: string } }>(
    "/library/copy/:id/shelves/:shelfId/delete",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      await prisma.shelfCopy
        .delete({
          where: { shelfId_copyId: { shelfId: req.params.shelfId, copyId: req.params.id } },
        })
        .catch(() => undefined);
      return reply.redirect(`/library/copy/${req.params.id}`);
    }
  );
}

// Prisma orderBy helper kept tiny for readability.
function shelf_copies_order_for(_isOrdered: boolean) {
  // Always return `position asc` from Prisma; final sort is done in JS so
  // unordered shelves can fall back to title.
  return [{ position: { sort: "asc" as const, nulls: "last" as const } }];
}
