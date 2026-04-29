import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";
import { refetchMissingCovers } from "./_cover-backfill.js";

interface AuthorCount {
  primaryAuthor: string;
  bookCount: number;
}

export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const libraryFilter = library ? { libraryId: library.id } : {};
    const activeCopyFilter = { ...libraryFilter, deletedAt: null };

    const [
      totalCopies,
      trashedCopies,
      trophyCount,
      shelfCount,
      copiesWithCover,
      copiesWithCondition,
      copiesWithEdition,
      copiesWithShelves,
      booksWithIsbn,
      booksWithoutCover,
      booksWithoutIsbn,
      booksTotal,
      addsLast7,
      addsLast30,
      addsLast90,
      editionGroups,
      authorRows,
      valueAggregate,
    ] = await Promise.all([
      prisma.physicalCopy.count({ where: activeCopyFilter }),
      prisma.physicalCopy.count({ where: { ...libraryFilter, deletedAt: { not: null } } }),
      prisma.trophy.count({ where: libraryFilter }),
      prisma.shelf.count({ where: libraryFilter }),
      prisma.physicalCopy.count({
        where: {
          ...activeCopyFilter,
          OR: [{ coverPath: { not: null } }, { book: { thumbnailUrl: { not: null } } }],
        },
      }),
      prisma.physicalCopy.count({ where: { ...activeCopyFilter, condition: { not: null } } }),
      prisma.physicalCopy.count({ where: { ...activeCopyFilter, edition: { not: null } } }),
      prisma.physicalCopy.count({
        where: { ...activeCopyFilter, shelves: { some: {} } },
      }),
      prisma.physicalCopy.count({
        where: { ...activeCopyFilter, book: { isbn13: { not: null } } },
      }),
      prisma.book.count({
        where: {
          thumbnailUrl: null,
          isbn13: { not: null },
          physicalCopies: library
            ? { some: { libraryId: library.id, deletedAt: null } }
            : { some: { deletedAt: null } },
        },
      }),
      prisma.book.count({
        where: {
          isbn13: null,
          physicalCopies: library
            ? { some: { libraryId: library.id, deletedAt: null } }
            : { some: { deletedAt: null } },
        },
      }),
      prisma.book.count({
        where: {
          physicalCopies: library
            ? { some: { libraryId: library.id, deletedAt: null } }
            : { some: { deletedAt: null } },
        },
      }),
      prisma.physicalCopy.count({
        where: {
          ...activeCopyFilter,
          addedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.physicalCopy.count({
        where: {
          ...activeCopyFilter,
          addedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.physicalCopy.count({
        where: {
          ...activeCopyFilter,
          addedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
      }),
      prisma.physicalCopy.groupBy({
        by: ["edition"],
        where: activeCopyFilter,
        _count: { _all: true },
        orderBy: { _count: { edition: "desc" } },
      }),
      prisma.book.groupBy({
        by: ["primaryAuthor"],
        where: {
          primaryAuthor: { not: null },
          physicalCopies: library
            ? { some: { libraryId: library.id, deletedAt: null } }
            : { some: { deletedAt: null } },
        },
        _count: { _all: true },
        orderBy: { _count: { primaryAuthor: "desc" } },
        take: 10,
      }),
      prisma.physicalCopy.aggregate({
        where: { ...activeCopyFilter, priceCents: { not: null } },
        _sum: { priceCents: true },
        _count: { priceCents: true },
      }),
    ]);

    function pct(part: number, whole: number): number {
      if (whole === 0) return 0;
      return Math.round((part / whole) * 100);
    }

    const completeness = {
      cover: { value: copiesWithCover, of: totalCopies, pct: pct(copiesWithCover, totalCopies) },
      isbn: { value: booksWithIsbn, of: totalCopies, pct: pct(booksWithIsbn, totalCopies) },
      condition: {
        value: copiesWithCondition,
        of: totalCopies,
        pct: pct(copiesWithCondition, totalCopies),
      },
      edition: {
        value: copiesWithEdition,
        of: totalCopies,
        pct: pct(copiesWithEdition, totalCopies),
      },
      shelf: {
        value: copiesWithShelves,
        of: totalCopies,
        pct: pct(copiesWithShelves, totalCopies),
      },
    };

    const editions = editionGroups.map((g) => ({
      label: g.edition || "(unspecified)",
      count: g._count._all,
    }));
    const topAuthors: AuthorCount[] = authorRows
      .filter((r) => r.primaryAuthor !== null)
      .map((r) => ({ primaryAuthor: r.primaryAuthor!, bookCount: r._count._all }));

    return reply.view(
      "stats.ejs",
      await withChrome(req, {
        totals: {
          copies: totalCopies,
          books: booksTotal,
          trophies: trophyCount,
          shelves: shelfCount,
          trash: trashedCopies,
        },
        completeness,
        editions,
        topAuthors,
        adds: { last7: addsLast7, last30: addsLast30, last90: addsLast90 },
        backfillCandidates: booksWithoutCover,
        booksMissingIsbn: booksWithoutIsbn,
        value: {
          totalCents: valueAggregate._sum.priceCents ?? 0,
          recordedCount: valueAggregate._count.priceCents ?? 0,
        },
      })
    );
  });

  // Web-triggered cover backfill. Processes up to N books per call so the
  // client can render progress and the request never hangs for minutes.
  app.post("/stats/backfill-covers", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const result = await refetchMissingCovers(50);
    return reply.send({ ok: true, ...result });
  });
}
