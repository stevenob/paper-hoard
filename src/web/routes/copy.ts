import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "../../shared/db.js";
import { env } from "../../shared/env.js";
import { audit } from "../../shared/audit.js";
import { CONDITIONS, EDITIONS } from "../../shared/picklists.js";
import { requireUser, withChrome } from "./_helpers.js";

const updateSchema = z.object({
  condition: z.enum(["", ...CONDITIONS]).optional(),
  edition: z.enum(["", ...EDITIONS]).optional(),
  notes: z.string().max(2000).optional(),
});

function blankToNull<T extends string | undefined>(v: T): string | null {
  return v && v.length > 0 ? v : null;
}

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function extForMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".bin";
}

export async function copyRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/library/copy/:id", async (req, reply) => {
    const copy = await prisma.physicalCopy.findUnique({
      where: { id: req.params.id },
      include: {
        book: true,
        addedBy: true,
        library: true,
        shelves: { include: { shelf: true } },
      },
    });
    if (!copy) return reply.status(404).send("Not found");
    const completions = await prisma.completion.findMany({
      where: { bookId: copy.bookId },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    const libraryShelves = await prisma.shelf.findMany({
      where: { libraryId: copy.libraryId },
      orderBy: { name: "asc" },
    });
    return reply.view(
      "copy.ejs",
      await withChrome(req, {
        copy,
        completions,
        editions: EDITIONS,
        conditions: CONDITIONS,
        libraryShelves,
      })
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
        notes: data.notes?.trim() || null,
      },
    });
    void audit({
      userId: user.id,
      action: "update",
      entity: "physicalCopy",
      entityId: updated.id,
      details: data,
    });

    if (req.headers.accept?.includes("application/json")) {
      return reply.send({ ok: true, copy: { id: updated.id } });
    }
    return reply.redirect(`/library/copy/${updated.id}`);
  });

  app.post<{ Params: { id: string } }>("/library/copy/:id/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const copy = await prisma.physicalCopy.findUnique({ where: { id: req.params.id } });
    if (copy?.coverPath) {
      await fs
        .unlink(path.join(path.resolve(env.UPLOADS_DIR), copy.coverPath))
        .catch(() => undefined);
    }
    await prisma.physicalCopy.delete({ where: { id: req.params.id } }).catch(() => undefined);
    void audit({
      userId: user.id,
      action: "delete",
      entity: "physicalCopy",
      entityId: req.params.id,
      details: { coverPath: copy?.coverPath ?? null },
    });
    return reply.redirect("/library");
  });

  app.post<{ Params: { id: string } }>("/library/copy/:id/cover", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const data = await req.file();
    if (!data) return reply.status(400).send("No file uploaded");
    if (!ALLOWED_IMAGE_MIMES.has(data.mimetype)) {
      return reply.status(415).send(`Unsupported file type: ${data.mimetype}`);
    }

    // Read full buffer (capped to ~5MB by multipart limits) so we can hash
    // the content for de-duplication and atomic write.
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (data.file.truncated) {
      return reply.status(413).send("File too large (max 5MB)");
    }

    const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const ext = extForMime(data.mimetype);
    const filename = `${sha}${ext}`;
    const uploadsDir = path.resolve(env.UPLOADS_DIR);
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(path.join(uploadsDir, filename), buf);

    // Replace previous cover if any.
    const existing = await prisma.physicalCopy.findUnique({ where: { id: req.params.id } });
    if (existing?.coverPath && existing.coverPath !== filename) {
      await fs.unlink(path.join(uploadsDir, existing.coverPath)).catch(() => undefined);
    }

    await prisma.physicalCopy.update({
      where: { id: req.params.id },
      data: { coverPath: filename },
    });
    return reply.redirect(`/library/copy/${req.params.id}`);
  });

  app.post<{ Params: { id: string } }>("/library/copy/:id/cover/delete", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const copy = await prisma.physicalCopy.findUnique({ where: { id: req.params.id } });
    if (copy?.coverPath) {
      await fs
        .unlink(path.join(path.resolve(env.UPLOADS_DIR), copy.coverPath))
        .catch(() => undefined);
      await prisma.physicalCopy.update({
        where: { id: req.params.id },
        data: { coverPath: null },
      });
    }
    return reply.redirect(`/library/copy/${req.params.id}`);
  });
}
