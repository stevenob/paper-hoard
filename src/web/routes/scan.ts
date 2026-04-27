import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMembership, recordScan } from "../../shared/repo.js";
import { prisma } from "../../shared/db.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const scanSchema = z.object({
  isbn: z.string().trim().optional(),
  title: z.string().trim().optional(),
  author: z.string().trim().optional(),
});

export async function scanRoutes(app: FastifyInstance) {
  app.get("/scan", async (req, reply) => {
    const recent = await prisma.physicalCopy.findMany({
      include: { book: true, addedBy: true },
      orderBy: { addedAt: "desc" },
      take: 5,
    });
    return reply.view("scan.ejs", await withChrome(req, { recent }));
  });

  // JSON endpoint hit by the in-page camera scanner.
  app.post("/scan", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library)
      return reply
        .status(400)
        .send({ ok: false, error: "No family library yet. Run /library in Discord first." });

    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ ok: false, error: "Invalid request." });
    if (!parsed.data.isbn && !parsed.data.title)
      return reply.status(400).send({ ok: false, error: "Provide an ISBN or title." });

    await ensureMembership(user.id, library.id);
    const result = await recordScan({
      libraryId: library.id,
      userId: user.id,
      ...parsed.data,
    });
    if (!result) return reply.status(404).send({ ok: false, error: "No matching book found." });

    return reply.send({
      ok: true,
      trophyAcquired: result.trophyAcquired,
      book: {
        title: result.meta.title,
        authors: result.meta.authors,
        isbn13: result.meta.isbn13,
        thumbnailUrl: result.meta.thumbnailUrl,
        source: result.meta.source,
      },
    });
  });
}
