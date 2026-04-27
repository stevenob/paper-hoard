import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { lookupByIsbn, searchByTitle } from "../../shared/metadata.js";
import { upsertBookFromMetadata } from "../../shared/repo.js";
import { getActiveUser, getOnlyLibrary, withChrome } from "./_helpers.js";

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
    const activeUser = await getActiveUser(req);
    const library = await getOnlyLibrary();
    if (!activeUser) {
      return reply.view(
        "completions_new.ejs",
        await withChrome(req, { error: "Pick an active user first (top right)." })
      );
    }
    if (!library) {
      return reply.view(
        "completions_new.ejs",
        await withChrome(req, {
          error: "No family library exists yet. Add Smaug to a Discord server and run /scan or /library first.",
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
    await prisma.completion.create({
      data: {
        userId: activeUser.id,
        libraryId: library.id,
        bookId: book.id,
        mediaType: data.mediaType,
        source: data.source || null,
        completedOn: data.completedOn ? new Date(data.completedOn) : null,
        rating: data.rating ?? null,
        notes: data.notes || null,
      },
    });

    if (data.addToTrophy === "on") {
      await prisma.trophy.upsert({
        where: { libraryId_bookId: { libraryId: library.id, bookId: book.id } },
        create: {
          libraryId: library.id,
          bookId: book.id,
          requestedByUserId: activeUser.id,
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
    }

    return reply.redirect("/completions");
  });
}
