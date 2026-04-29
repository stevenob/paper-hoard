import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

interface DupeGroup {
  key: string;
  title: string;
  primaryAuthor: string;
  books: Array<{
    id: string;
    title: string;
    authors: string[];
    isbn13: string | null;
    publisher: string | null;
    publishedAt: string | null;
    thumbnailUrl: string | null;
    copyCount: number;
    trophyCount: number;
    completionCount: number;
  }>;
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function normalizeAuthor(s: string): string {
  return s.toLowerCase().trim();
}

const mergeSchema = z.object({
  intoBookId: z.string().min(1),
});

export async function bookMergeRoutes(app: FastifyInstance) {
  app.get("/library/dupes", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const where = library
      ? {
          primaryAuthor: { not: null },
          physicalCopies: { some: { libraryId: library.id, deletedAt: null } },
        }
      : { primaryAuthor: { not: null } };

    const books = await prisma.book.findMany({
      where: where as never,
      include: {
        _count: {
          select: { physicalCopies: true, trophies: true, completions: true },
        },
      },
    });

    const groups = new Map<string, DupeGroup>();
    for (const b of books) {
      if (!b.primaryAuthor) continue;
      const key = normalizeAuthor(b.primaryAuthor) + "||" + normalizeTitle(b.title);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          title: b.title,
          primaryAuthor: b.primaryAuthor,
          books: [],
        };
        groups.set(key, g);
      }
      g.books.push({
        id: b.id,
        title: b.title,
        authors: b.authors,
        isbn13: b.isbn13,
        publisher: b.publisher,
        publishedAt: b.publishedAt,
        thumbnailUrl: b.thumbnailUrl,
        copyCount: b._count.physicalCopies,
        trophyCount: b._count.trophies,
        completionCount: b._count.completions,
      });
    }
    const dupes = Array.from(groups.values())
      .filter((g) => g.books.length > 1)
      .sort((a, b) => b.books.length - a.books.length);

    return reply.view("dupes.ejs", await withChrome(req, { dupes }));
  });

  // Merges `:id` (the loser) into `intoBookId` (the winner). Repoints
  // physical copies, completions, and trophies, then deletes the loser.
  // Trophies that would conflict (both books have a trophy in the same
  // library) drop the loser's trophy so the winner's survives.
  app.post<{ Params: { id: string } }>("/books/:id/merge", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "intoBookId required" });
    const loserId = req.params.id;
    const winnerId = parsed.data.intoBookId;
    if (loserId === winnerId) return reply.status(400).send({ error: "Cannot merge a book into itself" });

    const [winner, loser] = await Promise.all([
      prisma.book.findUnique({ where: { id: winnerId } }),
      prisma.book.findUnique({ where: { id: loserId } }),
    ]);
    if (!winner || !loser) return reply.status(404).send({ error: "Book not found" });

    await prisma.$transaction(async (tx) => {
      // Repoint physical copies + completions outright.
      await tx.physicalCopy.updateMany({
        where: { bookId: loserId },
        data: { bookId: winnerId },
      });
      await tx.completion.updateMany({
        where: { bookId: loserId },
        data: { bookId: winnerId },
      });

      // Trophies have a unique (libraryId, bookId) constraint. For each
      // loser-book trophy, only repoint if the winner doesn't already have
      // one in that library; otherwise drop the loser's trophy.
      const loserTrophies = await tx.trophy.findMany({
        where: { bookId: loserId },
      });
      for (const t of loserTrophies) {
        const winnerExists = await tx.trophy.findUnique({
          where: { libraryId_bookId: { libraryId: t.libraryId, bookId: winnerId } },
        });
        if (winnerExists) {
          await tx.trophy.delete({ where: { id: t.id } });
        } else {
          await tx.trophy.update({
            where: { id: t.id },
            data: { bookId: winnerId },
          });
        }
      }

      // Finally, retire the loser. Any leftover relations would FK-fail —
      // the updateMany calls above ensure there are none.
      await tx.book.delete({ where: { id: loserId } });
    });

    void audit({
      userId: user.id,
      action: "delete",
      entity: "book",
      entityId: loserId,
      details: { merged: "into", winnerId, title: loser.title },
    });
    void audit({
      userId: user.id,
      action: "update",
      entity: "book",
      entityId: winnerId,
      details: { merged: "from", loserId, title: loser.title },
    });

    return reply.redirect("/library/dupes");
  });
}
