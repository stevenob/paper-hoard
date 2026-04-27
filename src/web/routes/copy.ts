import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { CONDITIONS, EDITIONS } from "../../shared/picklists.js";
import { requireUser, withChrome } from "./_helpers.js";

const updateSchema = z.object({
  condition: z.enum(["", ...CONDITIONS]).optional(),
  edition: z.enum(["", ...EDITIONS]).optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

function blankToNull<T extends string | undefined>(v: T): string | null {
  return v && v.length > 0 ? v : null;
}

export async function copyRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/library/copy/:id", async (req, reply) => {
    const copy = await prisma.physicalCopy.findUnique({
      where: { id: req.params.id },
      include: { book: true, addedBy: true, library: true },
    });
    if (!copy) return reply.status(404).send("Not found");
    const completions = await prisma.completion.findMany({
      where: { bookId: copy.bookId },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    return reply.view(
      "copy.ejs",
      await withChrome(req, { copy, completions, editions: EDITIONS, conditions: CONDITIONS })
    );
  });

  app.post<{ Params: { id: string } }>("/library/copy/:id/edit", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid input" });
    const data = parsed.data;
    const updated = await prisma.physicalCopy.update({
      where: { id: req.params.id },
      data: {
        condition: blankToNull(data.condition),
        edition: blankToNull(data.edition),
        location: data.location?.trim() || null,
        notes: data.notes?.trim() || null,
      },
    });

    // The same endpoint serves both browser form posts (redirect) and
    // fetch() calls from the scan page (JSON).
    if (req.headers.accept?.includes("application/json")) {
      return reply.send({ ok: true, copy: { id: updated.id } });
    }
    return reply.redirect(`/library/copy/${updated.id}`);
  });

  app.post<{ Params: { id: string } }>("/library/copy/:id/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await prisma.physicalCopy.delete({ where: { id: req.params.id } }).catch(() => undefined);
    return reply.redirect("/library");
  });
}
