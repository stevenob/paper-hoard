import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { searchOpenLibrarySeries } from "../../shared/metadata.js";
import type { SeriesEntry } from "../../shared/metadata.js";
import { getCurrentLibrary, withChrome } from "./_helpers.js";

const querySchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export interface SeriesTile {
  title: string;
  authors: string[];
  position?: number;
  publishedYear?: number;
  thumbnailUrl?: string;
  status: "owned" | "missing" | "trophy";
  /** When owned, link target to the user's first non-deleted copy. */
  copyId?: string;
  /** When owned, the bookId for /books/<id>. */
  bookId?: string;
  /** OL Work id for missing books → external link. */
  olWorkId?: string;
  /** ISBN for the +trophy quick-add (best one we have). */
  isbn?: string;
  /** Trophy.id when on the wishlist (status="trophy"). */
  trophyId?: string;
}

export async function seriesRoutes(app: FastifyInstance) {
  /**
   * /series?name=<series>
   *
   * Renders all books in a series — the user's owned copies plus
   * everything else OL knows about. Owned tiles look like normal
   * posters; missing tiles dim and gain a MISSING pill. Tiles are
   * sorted by series position; books on the wishlist get a gold
   * pill.
   */
  app.get("/series", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send("Provide ?name=<series>");
    const seriesName = parsed.data.name;

    const library = await getCurrentLibrary(req);

    // 1. Pull every owned book in this series. Case-insensitive equality
    //    via Prisma's `mode: insensitive` (Postgres only — we are PG).
    const owned = library
      ? await prisma.book.findMany({
          where: {
            seriesName: { equals: seriesName, mode: "insensitive" },
            physicalCopies: { some: { libraryId: library.id, deletedAt: null } },
          },
          include: {
            physicalCopies: {
              where: { deletedAt: null, libraryId: library.id },
              select: { id: true, edition: true },
              orderBy: { addedAt: "asc" },
              take: 1,
            },
          },
        })
      : [];

    // 2. Pull active trophies for this library — used to decorate the
    //    'wishlisted' status on missing tiles.
    const trophies = library
      ? await prisma.trophy.findMany({
          where: {
            libraryId: library.id,
            book: {
              seriesName: { equals: seriesName, mode: "insensitive" },
            },
          },
          include: { book: { select: { isbn13: true, title: true } } },
        })
      : [];
    const trophyByTitleLower = new Map<string, string>();
    for (const t of trophies) {
      const k = (t.book.title ?? "").toLowerCase();
      if (k) trophyByTitleLower.set(k, t.id);
    }

    // 3. Hit OL for the canonical list of books in the series.
    //    Failures are non-fatal — we degrade to "owned only".
    const ol = await searchOpenLibrarySeries(seriesName).catch(() => [] as SeriesEntry[]);

    // 4. Merge. Key by lowercased title since OL has no stable ID.
    type Combined = SeriesTile;
    const byTitle = new Map<string, Combined>();
    for (const e of ol) {
      const k = e.title.toLowerCase();
      const trophyId = trophyByTitleLower.get(k);
      byTitle.set(k, {
        title: e.title,
        authors: e.authors,
        position: e.position,
        publishedYear: e.publishedYear,
        thumbnailUrl: e.thumbnailUrl,
        status: trophyId ? "trophy" : "missing",
        olWorkId: e.olWorkId,
        isbn: e.isbn13 ?? e.isbn10,
        trophyId,
      });
    }
    for (const b of owned) {
      const k = b.title.toLowerCase();
      const existing = byTitle.get(k);
      const copy = b.physicalCopies[0];
      const merged: Combined = {
        title: b.title,
        authors: b.primaryAuthor ? [b.primaryAuthor] : b.authors ?? [],
        position: b.seriesPosition ?? existing?.position,
        publishedYear: existing?.publishedYear ?? extractYear(b.publishedAt),
        thumbnailUrl: b.thumbnailUrl ?? existing?.thumbnailUrl,
        status: "owned",
        copyId: copy?.id,
        bookId: b.id,
        olWorkId: existing?.olWorkId,
        isbn: b.isbn13 ?? b.isbn10 ?? existing?.isbn,
      };
      byTitle.set(k, merged);
    }

    const tiles = Array.from(byTitle.values()).sort(compareSeriesTiles);

    const ownedCount = tiles.filter((t) => t.status === "owned").length;
    const missingCount = tiles.length - ownedCount;
    const firstYear = Math.min(...tiles.map((t) => t.publishedYear ?? Infinity));
    const earliestYear = Number.isFinite(firstYear) ? firstYear : null;

    const author = ownedAuthor(owned) ?? ol[0]?.authors?.[0] ?? null;

    return reply.view(
      "series.ejs",
      await withChrome(req, {
        seriesName,
        tiles,
        ownedCount,
        missingCount,
        earliestYear,
        author,
        olEmpty: ol.length === 0,
      })
    );
  });
}

function compareSeriesTiles(a: SeriesTile, b: SeriesTile): number {
  // Position when both have one (numeric ascending). Books without a
  // position fall to the end, sorted by publish year then title.
  if (a.position != null && b.position != null) return a.position - b.position;
  if (a.position != null) return -1;
  if (b.position != null) return 1;
  if (a.publishedYear && b.publishedYear) return a.publishedYear - b.publishedYear;
  return a.title.localeCompare(b.title);
}

function extractYear(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? Number(m[1]) : undefined;
}

function ownedAuthor(owned: { primaryAuthor: string | null }[]): string | null {
  for (const b of owned) if (b.primaryAuthor) return b.primaryAuthor;
  return null;
}
