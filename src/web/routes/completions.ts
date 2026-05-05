import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { lookupByIsbn, searchByTitle } from "../../shared/metadata.js";
import { upsertBookFromMetadata } from "../../shared/repo.js";
import { normalizeAsin } from "../../shared/kindle.js";
import { scheduleKindleAsinEnrichment } from "../../shared/kindle-enrichment.js";
import { getCurrentLibrary, requireUser, withChrome } from "./_helpers.js";

const newCompletionSchema = z.object({
  isbn: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  mediaType: z.enum(["ebook", "audiobook"]),
  source: z.string().optional(),
  completedOn: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().optional(),
  addToTrophy: z.union([z.literal("on"), z.literal("")]).optional(),
  desiredFormat: z.string().optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  reason: z.string().optional(),
  // Optional Kindle ASIN. Stamped onto the underlying Book row with
  // kindleAsinSource="manual" so a later auto-enrichment never
  // overwrites it. Empty string is ignored.
  kindleAsin: z.string().optional(),
});

export async function completionsRoutes(app: FastifyInstance) {
  app.get("/completions", async (req, reply) => {
    const completions = await prisma.completion.findMany({
      include: { book: true, user: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return reply.view("completions.ejs", await withChrome(req, { completions }));
  });

  app.get("/completions/new", async (req, reply) => {
    return reply.view("completions_new.ejs", await withChrome(req, { error: null as string | null }));
  });

  app.post("/completions/new", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    if (!library) {
      return reply.view(
        "completions_new.ejs",
        await withChrome(req, {
          error:
            "No family library exists yet. In Discord, run /library once so Smaug creates it.",
        })
      );
    }

    const parsed = newCompletionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.view(
        "completions_new.ejs",
        await withChrome(req, { error: parsed.error.issues.map((i) => i.message).join(", ") })
      );
    }
    const data = parsed.data;

    const meta = data.isbn
      ? await lookupByIsbn(data.isbn)
      : data.title
        ? (await searchByTitle([data.title, data.author].filter(Boolean).join(" ")))[0]
        : null;

    if (!meta) {
      return reply.view(
        "completions_new.ejs",
        await withChrome(req, { error: "Could not find that book." })
      );
    }

    const book = await upsertBookFromMetadata(meta);

    // Apply optional manual Kindle ASIN — stamped as user-curated so
    // a later auto-enrichment never overwrites it. Reject malformed
    // values with a 400 (single chokepoint via normalizeAsin).
    if (data.kindleAsin && data.kindleAsin.trim()) {
      const asin = normalizeAsin(data.kindleAsin);
      if (!asin) {
        return reply.view(
          "completions_new.ejs",
          await withChrome(req, {
            error: "Kindle ASIN must be 10 alphanumeric characters (e.g. B07ZPC9QD4).",
          })
        );
      }
      await prisma.book.update({
        where: { id: book.id },
        data: { kindleAsin: asin, kindleAsinSource: "manual" },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: book.id,
        details: { kindleAsin: asin, kindleAsinSource: "manual", source: "completions/new" },
      });
    }

    const completion = await prisma.completion.create({
      data: {
        userId: user.id,
        libraryId: library.id,
        bookId: book.id,
        mediaType: data.mediaType,
        source: data.source || null,
        completedOn: data.completedOn ? new Date(data.completedOn) : null,
        rating: data.rating ?? null,
        notes: data.notes || null,
      },
    });
    void audit({
      userId: user.id,
      action: "create",
      entity: "completion",
      entityId: completion.id,
      details: { bookId: book.id, mediaType: data.mediaType, source: data.source ?? null },
    });

    if (data.addToTrophy === "on") {
      const trophy = await prisma.trophy.upsert({
        where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
        create: {
          libraryId: library.id,
          bookId: book.id,
          requestedByUserId: user.id,
          desiredFormat: data.desiredFormat || null,
          priority: data.priority ?? 3,
          reason: data.reason || null,
        },
        update: {
          desiredFormat: data.desiredFormat || null,
          priority: data.priority ?? 3,
          reason: data.reason || null,
        },
      });
      void audit({
        userId: user.id,
        action: "create",
        entity: "trophy",
        entityId: trophy.id,
        details: { bookId: book.id, fromCompletion: completion.id },
      });
    }

    // Schedule a post-response Kindle ASIN enrichment on the book.
    // No-op if a manual ASIN was just set above (the manual-source
    // guard short-circuits before the OL fetch).
    scheduleKindleAsinEnrichment(reply, book.id);

    return reply.redirect("/completions");
  });
}
