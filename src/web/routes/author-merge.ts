import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

interface AuthorVariant {
  name: string;
  bookCount: number;
}

/**
 * Normalize a name for grouping: lowercase, strip punctuation, sort the
 * tokens so "Andy Weir" and "Weir, Andy" land in the same bucket. Doesn't
 * try to be smart about middle initials or "PhD" suffixes — those false
 * negatives are caught manually via the merge UI.
 */
function authorKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

const mergeSchema = z.object({
  intoName: z.string().trim().min(1).max(200),
  fromName: z.string().trim().min(1).max(200),
});

export async function authorMergeRoutes(app: FastifyInstance) {
  app.get("/library/authors/dupes", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const where = library
      ? {
          primaryAuthor: { not: null },
          physicalCopies: { some: { libraryId: library.id, deletedAt: null } },
        }
      : { primaryAuthor: { not: null } };

    const rows = await prisma.book.groupBy({
      by: ["primaryAuthor"],
      where: where as never,
      _count: { _all: true },
    });

    const groups = new Map<string, AuthorVariant[]>();
    for (const r of rows) {
      if (!r.primaryAuthor) continue;
      const key = authorKey(r.primaryAuthor);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ name: r.primaryAuthor, bookCount: r._count._all });
    }
    const dupes = Array.from(groups.values())
      .filter((g) => g.length > 1)
      .map((g) => g.sort((a, b) => b.bookCount - a.bookCount))
      .sort((a, b) => {
        const aTotal = a.reduce((s, v) => s + v.bookCount, 0);
        const bTotal = b.reduce((s, v) => s + v.bookCount, 0);
        return bTotal - aTotal;
      });

    return reply.view("author-dupes.ejs", await withChrome(req, { dupes }));
  });

  app.post("/library/authors/merge", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid input" });
    const { intoName, fromName } = parsed.data;
    if (intoName === fromName) return reply.redirect("/library/authors/dupes");

    // Update Book.primaryAuthor and the authors[] array entries that match
    // the loser name. The unique constraint on (libraryId, bookId) for
    // Trophy doesn't get involved — we're only renaming an author, not
    // moving books between authors.
    const books = await prisma.book.findMany({
      where: { OR: [{ primaryAuthor: fromName }, { authors: { has: fromName } }] },
    });
    let updated = 0;
    for (const b of books) {
      const data: Record<string, unknown> = {};
      if (b.primaryAuthor === fromName) data.primaryAuthor = intoName;
      if (b.authors.includes(fromName)) {
        data.authors = b.authors.map((a) => (a === fromName ? intoName : a));
      }
      if (Object.keys(data).length > 0) {
        await prisma.book.update({ where: { id: b.id }, data });
        updated++;
      }
    }
    void audit({
      userId: user.id,
      action: "update",
      entity: "book",
      entityId: "(bulk)",
      details: {
        operation: "author-merge",
        from: fromName,
        into: intoName,
        booksUpdated: updated,
      },
    });
    return reply.redirect("/library/authors/dupes");
  });
}
