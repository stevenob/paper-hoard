import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { requireUser } from "./_helpers.js";

const lendSchema = z.object({
  lentTo: z.string().trim().max(200),
  dueBack: z.string().trim().max(50).optional(),
});

function parseDueBack(input: string | undefined): Date | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function lendingRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/lend",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const parsed = lendSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data.lentTo) {
        return reply.status(400).send("lentTo required");
      }
      const updated = await prisma.physicalCopy.update({
        where: { id: req.params.id },
        data: {
          lentTo: parsed.data.lentTo,
          lentAt: new Date(),
          dueBack: parseDueBack(parsed.data.dueBack),
        },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: updated.id,
        details: {
          lent: true,
          to: parsed.data.lentTo,
          due: parsed.data.dueBack ?? null,
        },
      });
      return reply.redirect(`/library/copy/${updated.id}`);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/return",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const updated = await prisma.physicalCopy.update({
        where: { id: req.params.id },
        data: { lentTo: null, lentAt: null, dueBack: null },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "physicalCopy",
        entityId: updated.id,
        details: { lent: false },
      });
      return reply.redirect(`/library/copy/${updated.id}`);
    }
  );

  // List view of everything currently checked out, sorted by due date.
  app.get("/lending", async (req, reply) => {
    const { withChrome, getCurrentLibrary } = await import("./_helpers.js");
    const library = await getCurrentLibrary(req);
    const where = library
      ? { libraryId: library.id, lentTo: { not: null }, deletedAt: null }
      : { lentTo: { not: null }, deletedAt: null };
    const copies = await prisma.physicalCopy.findMany({
      where: where as never,
      include: { book: true, addedBy: true },
      orderBy: [{ dueBack: { sort: "asc", nulls: "last" } }, { lentAt: "desc" }],
    });
    // v3.5.13 stats: out, overdue, mean days out.
    const now = Date.now();
    let overdueCount = 0;
    let totalOutMs = 0;
    let outWithLentAt = 0;
    for (const c of copies) {
      if (c.dueBack && new Date(c.dueBack).getTime() < now) overdueCount++;
      if (c.lentAt) {
        totalOutMs += now - new Date(c.lentAt).getTime();
        outWithLentAt++;
      }
    }
    const avgOutDays = outWithLentAt > 0 ? Math.round(totalOutMs / outWithLentAt / 86400000) : 0;
    return reply.view(
      "lending.ejs",
      await withChrome(req, { copies, overdueCount, avgOutDays })
    );
  });
}
