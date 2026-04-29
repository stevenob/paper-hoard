import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { withChrome } from "./_helpers.js";

interface ActivityEntry {
  id: string;
  when: Date;
  who: string | null;
  verb: string;
  bookTitle: string | null;
  bookId: string | null;
  href: string | null;
}

export async function homeRoutes(app: FastifyInstance) {
  app.get("/", async (req, reply) => {
    const [physicalCount, trophyCount, completionCount, recent, auditRows] =
      await Promise.all([
        prisma.physicalCopy.count({ where: { deletedAt: null } }),
        prisma.trophy.count(),
        prisma.completion.count(),
        prisma.physicalCopy.findMany({
          where: { deletedAt: null },
          include: { book: true, addedBy: true },
          orderBy: { addedAt: "desc" },
          take: 12,
        }),
        prisma.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          take: 30,
        }),
      ]);

    const userIds = Array.from(
      new Set(auditRows.map((r) => r.userId).filter((x): x is string => Boolean(x)))
    );
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const usersById = new Map(users.map((u) => [u.id, u.displayName]));

    // Resolve the entityId for the entities we know about so we can show
    // titles + links. Bulk-fetch in two queries.
    const copyIds = auditRows.filter((r) => r.entity === "physicalCopy").map((r) => r.entityId);
    const trophyIds = auditRows.filter((r) => r.entity === "trophy").map((r) => r.entityId);
    const completionIds = auditRows
      .filter((r) => r.entity === "completion")
      .map((r) => r.entityId);
    const [copies, trophies, completions] = await Promise.all([
      copyIds.length
        ? prisma.physicalCopy.findMany({
            where: { id: { in: copyIds } },
            include: { book: true },
          })
        : Promise.resolve([]),
      trophyIds.length
        ? prisma.trophy.findMany({
            where: { id: { in: trophyIds } },
            include: { book: true },
          })
        : Promise.resolve([]),
      completionIds.length
        ? prisma.completion.findMany({
            where: { id: { in: completionIds } },
            include: { book: true },
          })
        : Promise.resolve([]),
    ]);
    const copiesById = new Map(copies.map((c) => [c.id, c]));
    const trophiesById = new Map(trophies.map((t) => [t.id, t]));
    const completionsById = new Map(completions.map((c) => [c.id, c]));

    const activity: ActivityEntry[] = auditRows.slice(0, 12).map((r) => {
      const who = (r.userId && usersById.get(r.userId)) ?? "system";
      let verb = `${r.action}d ${r.entity}`;
      let bookTitle: string | null = null;
      let bookId: string | null = null;
      let href: string | null = null;
      let attributable = true;
      if (r.entity === "physicalCopy") {
        const c = copiesById.get(r.entityId);
        if (c) {
          bookTitle = c.book.title;
          bookId = c.bookId;
          href = `/library/copy/${c.id}`;
        }
        if (r.action === "create") {
          verb = "Added";
          attributable = false;
        } else if (r.action === "delete") {
          verb = "removed";
        } else {
          verb = "edited";
        }
      } else if (r.entity === "trophy") {
        const t = trophiesById.get(r.entityId);
        if (t) {
          bookTitle = t.book.title;
          bookId = t.bookId;
          href = `/books/${t.bookId}`;
        }
        if (r.action === "create") {
          verb = "added trophy for";
        } else if (r.action === "delete") {
          verb = "acquired or removed trophy for";
        } else {
          verb = "updated trophy for";
        }
      } else if (r.entity === "completion") {
        const c = completionsById.get(r.entityId);
        if (c) {
          bookTitle = c.book.title;
          bookId = c.bookId;
          href = `/books/${c.bookId}`;
        }
        verb = "logged a completion of";
      }
      return {
        id: r.id,
        when: r.createdAt,
        who: attributable ? who : null,
        verb,
        bookTitle,
        bookId,
        href,
      };
    });

    return reply.view(
      "home.ejs",
      await withChrome(req, {
        physicalCount,
        trophyCount,
        completionCount,
        recent,
        activity,
      })
    );
  });

  app.get("/healthz", async () => ({ ok: true }));
}
