import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { startReading, finishReading } from "../../shared/readings.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const finishSchema = z.object({
  rating: z
    .union([z.coerce.number().int().min(1).max(5), z.literal("")])
    .optional(),
  notes: z.string().max(2000).optional(),
  logCompletion: z
    .union([z.literal("on"), z.literal("true"), z.boolean()])
    .optional(),
});

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "on";
}

export async function readingRoutes(app: FastifyInstance) {
  app.get("/readings", async (req, reply) => {
    const library = await getCurrentLibrary(req);
    const where = library ? { libraryId: library.id } : {};
    const [active, finished] = await Promise.all([
      prisma.reading.findMany({
        where: { ...where, finishedAt: null },
        include: { user: true, copy: { include: { book: true } } },
        orderBy: { startedAt: "desc" },
      }),
      prisma.reading.findMany({
        where: { ...where, finishedAt: { not: null } },
        include: { user: true, copy: { include: { book: true } } },
        orderBy: { finishedAt: "desc" },
        take: 30,
      }),
    ]);
    return reply.view(
      "readings.ejs",
      await withChrome(req, { active, finished })
    );
  });

  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/start-reading",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const copy = await prisma.physicalCopy.findUnique({
        where: { id: req.params.id },
      });
      if (!copy || copy.deletedAt) return reply.status(404).send("Copy not found");
      await startReading({
        userId: user.id,
        libraryId: copy.libraryId,
        copyId: copy.id,
      });
      return reply.redirect(`/library/copy/${copy.id}`);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/readings/:id/finish",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const reading = await prisma.reading.findUnique({
        where: { id: req.params.id },
      });
      if (!reading) return reply.status(404).send("Not found");
      const parsed = finishSchema.safeParse(req.body ?? {});
      const data = parsed.success ? parsed.data : {};
      const ratingNum =
        typeof data.rating === "number" && data.rating > 0 ? data.rating : null;
      const notes = data.notes && data.notes.trim().length > 0 ? data.notes.trim() : null;
      await finishReading({
        readingId: reading.id,
        userId: user.id,
        createCompletion: truthy(data.logCompletion),
        rating: ratingNum,
        notes,
      });
      const referer = req.headers.referer ?? "/readings";
      return reply.redirect(referer);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/readings/:id/delete",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const reading = await prisma.reading.findUnique({
        where: { id: req.params.id },
      });
      if (!reading) return reply.redirect("/readings");
      await prisma.reading.delete({ where: { id: reading.id } });
      void audit({
        userId: user.id,
        action: "delete",
        entity: "reading",
        entityId: reading.id,
        details: { copyId: reading.copyId },
      });
      const referer = req.headers.referer ?? "/readings";
      return reply.redirect(referer);
    }
  );
}
