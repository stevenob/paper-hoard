import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/db.js";
import { fuzzyMatchingBookIds } from "../../shared/search.js";
import { withChrome } from "./_helpers.js";

const SORT_FIELDS = ["added", "title", "author"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const VIEW_MODES = ["grid", "list"] as const;

const querySchema = z.object({
  q: z.string().trim().optional(),
  shelf: z.string().trim().optional(),
  sort: z.enum(SORT_FIELDS).default("author"),
  order: z.enum(["asc", "desc"]).default("asc"),
  view: z.enum(VIEW_MODES).default("grid"),
  page: z.coerce.number().int().min(1).default(1),
});

const PAGE_SIZE = 60;

export async function libraryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, string> }>("/library", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    const params = parsed.success ? parsed.data : querySchema.parse({});
    const skip = (params.page - 1) * PAGE_SIZE;

    const where: Record<string, unknown> = { deletedAt: null };
    if (params.q) {
      // Trigram-backed fuzzy search across title + primaryAuthor + authors[].
      // Tolerates typos and word-order variations the old substring search
      // would have missed ("projct hail mary" → "Project Hail Mary").
      const bookIds = await fuzzyMatchingBookIds(params.q);
      where.book = { id: { in: bookIds } };
    }
    if (params.shelf) {
      where.shelves = { some: { shelf: { slug: params.shelf } } };
    }

    const orderBy = (() => {
      const dir = params.order;
      switch (params.sort) {
        case "title":
          return { book: { title: dir } } as const;
        case "author":
          return [
            { book: { primaryAuthor: { sort: dir, nulls: "last" } } },
            { book: { title: dir } },
          ] as Prisma.PhysicalCopyOrderByWithRelationInput[];
        case "added":
        default:
          return { addedAt: dir } as const;
      }
    })();

    const [copies, total, activeShelf] = await Promise.all([
      prisma.physicalCopy.findMany({
        where,
        include: { book: true, library: true, shelves: { include: { shelf: true } } },
        orderBy,
        take: PAGE_SIZE,
        skip,
      }),
      prisma.physicalCopy.count({ where }),
      params.shelf
        ? prisma.shelf.findFirst({ where: { slug: params.shelf } })
        : Promise.resolve(null),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const ctx = await withChrome(req, {
      copies,
      params,
      total,
      totalPages,
      pageSize: PAGE_SIZE,
      sortFields: SORT_FIELDS,
      activeShelf,
    });
    return reply.view("library.ejs", ctx);
  });
}