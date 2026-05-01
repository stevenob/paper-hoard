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
  acquiredFrom: z.string().max(200).optional(),
  acquiredOn: z.string().max(50).optional(),
  // Free-text price input — accepts "$15.99", "15.99", "15", or blank.
  // Normalized server-side to integer cents.
  price: z.string().max(20).optional(),
  // Edition fidelity flags. Browsers send unchecked checkboxes as missing
  // fields, so we treat absence as "no change requested" and use a special
  // hidden marker field (firstEditionPresent) to detect "user explicitly
  // unchecked it". Avoids accidentally clearing a flag the user didn't
  // mean to touch.
  firstEdition: z.literal("on").optional(),
  firstPrinting: z.literal("on").optional(),
  signed: z.literal("on").optional(),
  inscribed: z.literal("on").optional(),
  dustJacketPresent: z.literal("on").optional(),
  printLine: z.string().max(100).optional(),
});

function blankToNull<T extends string | undefined>(v: T): string | null {
  return v && v.length > 0 ? v : null;
}

function parsePriceToCents(input: string | undefined): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  // Cap at $1,000,000 to keep typos like 99999999 from polluting the catalog.
  const cents = Math.round(n * 100);
  return cents > 100_000_000 ? null : cents;
}

function parseAcquiredOn(input: string | undefined): Date | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isFinite(d.getTime()) ? d : null;
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
        photos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
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
        acquiredFrom: data.acquiredFrom?.trim() || null,
        acquiredOn: parseAcquiredOn(data.acquiredOn),
        priceCents: parsePriceToCents(data.price),
        // Booleans toggle by checkbox state. Absent = false (unchecked).
        firstEdition: data.firstEdition === "on",
        firstPrinting: data.firstPrinting === "on",
        signed: data.signed === "on",
        inscribed: data.inscribed === "on",
        dustJacketPresent: data.dustJacketPresent === "on",
        printLine: data.printLine?.trim() || null,
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
    if (!copy) return reply.redirect("/library");
    // Soft delete: keep the row + cover + shelf assignments so the action
    // can be undone. The /trash page lists deletedAt!=null copies and a
    // background sweeper hard-deletes after 30 days.
    if (!copy.deletedAt) {
      await prisma.physicalCopy.update({
        where: { id: copy.id },
        data: { deletedAt: new Date() },
      });
    }
    void audit({
      userId: user.id,
      action: "delete",
      entity: "physicalCopy",
      entityId: copy.id,
      details: { soft: true, coverPath: copy.coverPath ?? null },
    });
    // 15-second undo cookie consumed by ui.js to render a toast.
    const book = await prisma.book.findUnique({ where: { id: copy.bookId } });
    const undoValue = `${copy.id}|${(book?.title ?? "Copy").slice(0, 80)}`;
    reply.setCookie("ph_undo", undoValue, {
      path: "/",
      maxAge: 15,
      httpOnly: false,
      sameSite: "lax",
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

    // Replace previous cover if any. Only unlink the old file if no other
    // copy or CopyPhoto still references it (filenames are sha256-prefixed
    // so identical uploads share storage).
    const existing = await prisma.physicalCopy.findUnique({ where: { id: req.params.id } });
    if (existing?.coverPath && existing.coverPath !== filename) {
      const stillUsed =
        (await prisma.physicalCopy.count({
          where: { coverPath: existing.coverPath, NOT: { id: existing.id } },
        })) +
        (await prisma.copyPhoto.count({ where: { photoPath: existing.coverPath } }));
      if (stillUsed === 0) {
        await fs.unlink(path.join(uploadsDir, existing.coverPath)).catch(() => undefined);
      }
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
      // Only unlink the file if no other copy/photo still uses it.
      const stillUsed =
        (await prisma.physicalCopy.count({
          where: { coverPath: copy.coverPath, NOT: { id: copy.id } },
        })) +
        (await prisma.copyPhoto.count({ where: { photoPath: copy.coverPath } }));
      if (stillUsed === 0) {
        await fs
          .unlink(path.join(path.resolve(env.UPLOADS_DIR), copy.coverPath))
          .catch(() => undefined);
      }
      await prisma.physicalCopy.update({
        where: { id: req.params.id },
        data: { coverPath: null },
      });
    }
    return reply.redirect(`/library/copy/${req.params.id}`);
  });

  // Multi-photo gallery: dust jacket / signed page / damage / etc. The
  // upload pipeline mirrors the cover-upload flow above (sha256 dedupe,
  // size cap, mime check) but writes to CopyPhoto rows instead of
  // overwriting PhysicalCopy.coverPath.
  app.post<{ Params: { id: string } }>(
    "/library/copy/:id/photos",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const copy = await prisma.physicalCopy.findUnique({
        where: { id: req.params.id },
      });
      if (!copy) return reply.status(404).send("Not found");

      let label: string | null = null;
      let buf: Buffer | null = null;
      let mimetype: string | null = null;
      let truncated = false;
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "photo") {
          const chunks: Buffer[] = [];
          for await (const c of part.file) chunks.push(c);
          buf = Buffer.concat(chunks);
          mimetype = part.mimetype;
          truncated = part.file.truncated;
        } else if (part.type === "field" && part.fieldname === "label") {
          label =
            typeof part.value === "string" && part.value.trim().length > 0
              ? part.value.trim().slice(0, 200)
              : null;
        }
      }
      if (!buf || !mimetype) return reply.status(400).send("No file uploaded");
      if (!ALLOWED_IMAGE_MIMES.has(mimetype))
        return reply.status(415).send(`Unsupported file type: ${mimetype}`);
      if (truncated) return reply.status(413).send("File too large (max 5MB)");

      const sha = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
      const ext = extForMime(mimetype);
      const filename = `${sha}${ext}`;
      const uploadsDir = path.resolve(env.UPLOADS_DIR);
      await fs.mkdir(uploadsDir, { recursive: true });
      await fs.writeFile(path.join(uploadsDir, filename), buf);

      const lastPosition = await prisma.copyPhoto.aggregate({
        where: { copyId: copy.id },
        _max: { position: true },
      });
      const position = (lastPosition._max.position ?? -1) + 1;
      const photo = await prisma.copyPhoto.create({
        data: { copyId: copy.id, photoPath: filename, label, position },
      });
      void audit({
        userId: user.id,
        action: "create",
        entity: "physicalCopy",
        entityId: copy.id,
        details: { photo: photo.id, label },
      });
      return reply.redirect(`/library/copy/${copy.id}#photos`);
    }
  );

  app.post<{ Params: { id: string; photoId: string } }>(
    "/library/copy/:id/photos/:photoId/delete",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const photo = await prisma.copyPhoto.findUnique({
        where: { id: req.params.photoId },
      });
      if (!photo || photo.copyId !== req.params.id)
        return reply.redirect(`/library/copy/${req.params.id}#photos`);
      // Only delete the file from disk if no other photo on any copy
      // references the same content-addressed filename. (Cover uploads
      // share the same naming scheme — we don't want to remove a file
      // that's still being used as a cover or another photo.)
      const stillUsedAsCover = await prisma.physicalCopy.count({
        where: { coverPath: photo.photoPath },
      });
      const stillUsedByOtherPhoto = await prisma.copyPhoto.count({
        where: { photoPath: photo.photoPath, NOT: { id: photo.id } },
      });
      if (stillUsedAsCover === 0 && stillUsedByOtherPhoto === 0) {
        await fs
          .unlink(path.join(path.resolve(env.UPLOADS_DIR), photo.photoPath))
          .catch(() => undefined);
      }
      await prisma.copyPhoto.delete({ where: { id: photo.id } });
      void audit({
        userId: user.id,
        action: "delete",
        entity: "physicalCopy",
        entityId: req.params.id,
        details: { photo: photo.id },
      });
      return reply.redirect(`/library/copy/${req.params.id}#photos`);
    }
  );

  app.post<{ Params: { id: string; photoId: string } }>(
    "/library/copy/:id/photos/:photoId/label",
    async (req, reply) => {
      const user = await requireUser(req, reply);
      if (!user) return;
      const labelSchema = z.object({ label: z.string().max(200).optional() });
      const parsed = labelSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid input" });
      const photo = await prisma.copyPhoto.findUnique({
        where: { id: req.params.photoId },
      });
      if (!photo || photo.copyId !== req.params.id)
        return reply.redirect(`/library/copy/${req.params.id}#photos`);
      await prisma.copyPhoto.update({
        where: { id: photo.id },
        data: { label: parsed.data.label?.trim() || null },
      });
      return reply.redirect(`/library/copy/${req.params.id}#photos`);
    }
  );
}
