import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../../shared/db.js";
import { audit } from "../../shared/audit.js";
import { requireUser, withChrome } from "./_helpers.js";

function newSlug(): string {
  return crypto.randomBytes(8).toString("base64url");
}

const channelSchema = z.object({
  channelId: z.string().trim().regex(/^\d{0,30}$/, "Discord channel IDs are numeric").optional(),
});

export async function shareRoutes(app: FastifyInstance) {
  // Public read-only library view.
  app.get<{ Params: { slug: string } }>("/share/:slug", async (req, reply) => {
    const library = await prisma.library.findUnique({
      where: { publicSlug: req.params.slug },
    });
    if (!library) return reply.status(404).send("Not found");

    const [copies, trophies] = await Promise.all([
      prisma.physicalCopy.findMany({
        where: { libraryId: library.id },
        include: { book: true },
        orderBy: { addedAt: "desc" },
        take: 500,
      }),
      prisma.trophy.findMany({
        where: { libraryId: library.id },
        include: { book: true },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      }),
    ]);
    return reply.view("share.ejs", await withChrome(req, { library, copies, trophies }));
  });

  // Owner controls — toggle public sharing on the user's library.
  app.post<{ Params: { id: string } }>(
    "/libraries/:id/share/enable",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const updated = await prisma.library.update({
        where: { id: req.params.id },
        data: { publicSlug: newSlug() },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: updated.id,
        details: { share: "enabled", slug: updated.publicSlug },
      });
      return reply.redirect("/about");
    }
  );

  app.post<{ Params: { id: string } }>(
    "/libraries/:id/share/regenerate",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const updated = await prisma.library.update({
        where: { id: req.params.id },
        data: { publicSlug: newSlug() },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: updated.id,
        details: { share: "regenerated", slug: updated.publicSlug },
      });
      return reply.redirect("/about");
    }
  );

  app.post<{ Params: { id: string } }>(
    "/libraries/:id/share/disable",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const updated = await prisma.library.update({
        where: { id: req.params.id },
        data: { publicSlug: null },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: updated.id,
        details: { share: "disabled" },
      });
      return reply.redirect("/about");
    }
  );

  // Set / clear the Discord channel ID we post to on add.
  app.post<{ Params: { id: string } }>(
    "/libraries/:id/notify-channel",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const parsed = channelSchema.safeParse(req.body);
      if (!parsed.success) return reply.redirect("/about");
      const channelId = parsed.data.channelId?.trim() || null;
      const updated = await prisma.library.update({
        where: { id: req.params.id },
        data: { notifyChannelId: channelId },
      });
      void audit({
        userId: user.id,
        action: "update",
        entity: "book",
        entityId: updated.id,
        details: { notifyChannel: channelId ? "set" : "cleared" },
      });
      return reply.redirect("/about");
    }
  );
}
