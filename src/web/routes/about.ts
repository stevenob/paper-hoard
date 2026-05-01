import type { FastifyInstance } from "fastify";
import { prisma } from "../../shared/db.js";
import { env } from "../../shared/env.js";
import { getCurrentLibrary, withChrome } from "./_helpers.js";

interface AuthorCount {
  primaryAuthor: string;
  bookCount: number;
}

/**
 * Extract a 4-digit year from a freeform publishedAt string (e.g.
 * "1954", "2021-05-04", "May 2018", "Oct 01, 1994") so we can sort
 * publications chronologically. Returns null when no year is found.
 */
function extractYear(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/(\b\d{4}\b)/);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  return Number.isFinite(y) && y >= 1000 && y <= 2999 ? y : null;
}

export async function aboutRoutes(app: FastifyInstance) {
  // Catalog stats + library admin in one page. Replaces the old separate
  // /stats and /about. The old /stats URL still lands here via the redirect
  // wired in stats.ts so existing bookmarks stay alive.
  app.get("/about", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const libraryFilter = library ? { libraryId: library.id } : {};
    const activeCopyFilter = { ...libraryFilter, deletedAt: null };

    let dbOk = true;
    let counts = {
      libraries: 0,
      users: 0,
      auditLog: 0,
    };

    type CatalogShape = {
      totalCopies: number;
      trashedCopies: number;
      trophyCount: number;
      shelfCount: number;
      copiesWithCover: number;
      copiesWithCondition: number;
      copiesWithEdition: number;
      copiesWithShelves: number;
      booksWithIsbn: number;
      booksWithoutCover: number;
      booksWithoutIsbn: number;
      booksTotal: number;
      addsLast7: number;
      addsLast30: number;
      addsLast90: number;
      editionGroups: { edition: string | null; _count: { _all: number } }[];
      authorRows: { primaryAuthor: string | null; _count: { _all: number } }[];
      valueAggregate: { _sum: { priceCents: number | null }; _count: { priceCents: number } };
      lowResCovers: number;
      missingAuthors: number;
      datedCopies: { id: string; book: { id: string; title: string; primaryAuthor: string | null; publishedAt: string | null; thumbnailUrl: string | null; coverPath?: string | null } & Record<string, unknown> }[];
      mostExpensiveCopies: Awaited<ReturnType<typeof prisma.physicalCopy.findMany>>;
      activeLending: number;
    };

    let catalog: CatalogShape | null = null;

    try {
      const [
        libraries,
        users,
        auditLog,
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
        lowResCovers,
        missingAuthors,
        datedCopies,
        mostExpensiveCopies,
        activeLending,
      ] = await Promise.all([
        prisma.library.count(),
        prisma.user.count(),
        prisma.auditLog.count(),
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
            // Match the helper's skip-recently-attempted filter so the
            // count next to the Run button agrees with what'll actually
            // get processed. (Books attempted in the last 30d are
            // excluded — see RETRY_AFTER_DAYS in _cover-backfill.ts.)
            OR: [
              { coverAttemptedAt: null },
              { coverAttemptedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
            ],
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
        prisma.book.count({
          where: {
            isbn13: { not: null },
            thumbnailUrl: { not: null },
            source: { not: "manual" },
            OR: [
              { thumbnailUrl: { contains: "zoom=" } },
              { thumbnailUrl: { contains: "edge=curl" } },
              { thumbnailUrl: { contains: "-M.jpg" } },
              { thumbnailUrl: { contains: "-S.jpg" } },
              { thumbnailUrl: { startsWith: "http://" } },
            ],
          },
        }),
        prisma.book.count({
          where: {
            primaryAuthor: null,
            physicalCopies: library
              ? { some: { libraryId: library.id, deletedAt: null } }
              : { some: { deletedAt: null } },
          },
        }),
        // For oldest/newest: pull all dated copies, sort in JS by parsed
        // year so we can ignore the freeform 'May 2018' / 'Oct 01, 1994'
        // strings that lex-sort puts in the wrong place.
        prisma.physicalCopy.findMany({
          where: { ...activeCopyFilter, book: { publishedAt: { not: null } } },
          include: { book: true },
          take: 500,
        }),
        prisma.physicalCopy.findMany({
          where: { ...activeCopyFilter, priceCents: { not: null } },
          include: { book: true },
          orderBy: { priceCents: "desc" },
          take: 10,
        }),
        prisma.physicalCopy.count({
          where: { ...activeCopyFilter, lentTo: { not: null } },
        }),
      ]);
      counts = { libraries, users, auditLog };
      catalog = {
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
        lowResCovers,
        missingAuthors,
        datedCopies,
        mostExpensiveCopies,
        activeLending,
      };
    } catch {
      dbOk = false;
    }

    function pct(part: number, whole: number): number {
      if (whole === 0) return 0;
      return Math.round((part / whole) * 100);
    }

    const completeness = catalog
      ? {
          cover: { value: catalog.copiesWithCover, of: catalog.totalCopies, pct: pct(catalog.copiesWithCover, catalog.totalCopies) },
          isbn: { value: catalog.booksWithIsbn, of: catalog.totalCopies, pct: pct(catalog.booksWithIsbn, catalog.totalCopies) },
          condition: { value: catalog.copiesWithCondition, of: catalog.totalCopies, pct: pct(catalog.copiesWithCondition, catalog.totalCopies) },
          edition: { value: catalog.copiesWithEdition, of: catalog.totalCopies, pct: pct(catalog.copiesWithEdition, catalog.totalCopies) },
          shelf: { value: catalog.copiesWithShelves, of: catalog.totalCopies, pct: pct(catalog.copiesWithShelves, catalog.totalCopies) },
        }
      : null;

    const editions = catalog
      ? catalog.editionGroups.map((g) => ({
          label: g.edition || "(unspecified)",
          count: g._count._all,
        }))
      : [];

    const topAuthors: AuthorCount[] = catalog
      ? catalog.authorRows
          .filter((r) => r.primaryAuthor !== null)
          .map((r) => ({ primaryAuthor: r.primaryAuthor!, bookCount: r._count._all }))
      : [];

    // Sort dated copies by extracted year, drop ones with no parseable year.
    const sortedByYear = catalog
      ? catalog.datedCopies
          .map((c) => ({ copy: c, year: extractYear(c.book.publishedAt) }))
          .filter((x) => x.year !== null)
          .sort((a, b) => (a.year! - b.year!))
      : [];
    const oldestCopies = sortedByYear.slice(0, 10).map((x) => x.copy);
    const newestCopies = sortedByYear.slice(-10).reverse().map((x) => x.copy);

    const library0 = await prisma.library.findFirst({ orderBy: { createdAt: "asc" } }).catch(() => null);

    return reply.view(
      "about.ejs",
      await withChrome(req, {
        // System info (was /about)
        gitSha: env.GIT_SHA,
        imageTag: env.IMAGE_TAG,
        nodeVersion: process.version,
        uptimeSec: Math.round(process.uptime()),
        dbOk,
        counts,
        library0,
        webBaseUrl: env.WEB_BASE_URL ?? null,
        repoUrl: "https://github.com/stevenob/paper-hoard",
        ghcrUrl: "https://github.com/stevenob/paper-hoard/pkgs/container/paper-hoard",
        // Catalog data (was /stats)
        totals: catalog
          ? {
              copies: catalog.totalCopies,
              books: catalog.booksTotal,
              trophies: catalog.trophyCount,
              shelves: catalog.shelfCount,
              trash: catalog.trashedCopies,
            }
          : null,
        completeness,
        editions,
        topAuthors,
        adds: catalog ? { last7: catalog.addsLast7, last30: catalog.addsLast30, last90: catalog.addsLast90 } : null,
        backfillCandidates: catalog?.booksWithoutCover ?? 0,
        booksMissingIsbn: catalog?.booksWithoutIsbn ?? 0,
        lowResCovers: catalog?.lowResCovers ?? 0,
        missingAuthors: catalog?.missingAuthors ?? 0,
        oldestCopies,
        newestCopies,
        mostExpensiveCopies: catalog?.mostExpensiveCopies ?? [],
        activeLending: catalog?.activeLending ?? 0,
        value: catalog
          ? {
              totalCents: catalog.valueAggregate._sum.priceCents ?? 0,
              recordedCount: catalog.valueAggregate._count.priceCents ?? 0,
            }
          : { totalCents: 0, recordedCount: 0 },
      })
    );
  });
}
