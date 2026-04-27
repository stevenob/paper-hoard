import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureMembership, recordScan } from "../../shared/repo.js";
import { prisma } from "../../shared/db.js";
import { getActiveUser, getOnlyLibrary, withChrome } from "./_helpers.js";

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
    const activeUser = await getActiveUser(req);
    const library = await getOnlyLibrary();
    if (!activeUser) return reply.status(400).send({ ok: false, error: "Pick an active user first." });
    if (!library)
      return reply
        .status(400)
        .send({ ok: false, error: "No family library yet. Run /library in Discord first." });

    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ ok: false, error: "Invalid request." });
    if (!parsed.data.isbn && !parsed.data.title)
      return reply.status(400).send({ ok: false, error: "Provide an ISBN or title." });

    await ensureMembership(activeUser.id, library.id);
    const result = await recordScan({
      libraryId: library.id,
      userId: activeUser.id,
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
