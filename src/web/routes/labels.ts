import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { prisma } from "../../shared/db.js";
import { env } from "../../shared/env.js";
import { getCurrentLibrary, withChrome } from "./_helpers.js";

interface LabelEntry {
  copyId: string;
  title: string;
  primaryAuthor: string | null;
  qrSvg: string;
}

/**
 * Generate the URL a spine sticker should encode. We use the configured
 * WEB_BASE_URL when it's set so QRs scanned in the wild deep-link the
 * right way; otherwise we fall back to a relative-style URL the camera
 * UI handles via the spine-sticker code path.
 */
function copyUrl(copyId: string): string {
  const base = (env.WEB_BASE_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/library/copy/${copyId}` : `/library/copy/${copyId}`;
}

export async function labelRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { shelf?: string; size?: string } }>(
    "/library/labels",
    async (req, reply) => {
      const library = await getCurrentLibrary(req);
      if (!library) return reply.status(400).send("No library");

      const where: Record<string, unknown> = {
        libraryId: library.id,
        deletedAt: null,
      };
      if (req.query.shelf) {
        where.shelves = { some: { shelf: { slug: req.query.shelf } } };
      }

      const copies = await prisma.physicalCopy.findMany({
        where,
        include: { book: true },
        orderBy: [
          { book: { primaryAuthor: { sort: "asc", nulls: "last" } } },
          { book: { title: "asc" } },
        ],
        // Cap at 600 — about 6 sheets of 30-up labels. Anything larger
        // should be paginated; we generate QRs synchronously and don't
        // want to OOM on a 5000-book library.
        take: 600,
      });

      const labels: LabelEntry[] = await Promise.all(
        copies.map(async (c) => {
          const url = copyUrl(c.id);
          const qrSvg = await QRCode.toString(url, {
            type: "svg",
            margin: 1,
            errorCorrectionLevel: "M",
          });
          return {
            copyId: c.id,
            title: c.book.title,
            primaryAuthor: c.book.primaryAuthor,
            qrSvg,
          };
        })
      );

      const size = req.query.size === "large" ? "large" : "small";
      const allShelves = await prisma.shelf.findMany({
        where: { libraryId: library.id },
        orderBy: { name: "asc" },
      });

      return reply.view(
        "labels.ejs",
        await withChrome(req, {
          labels,
          size,
          shelfFilter: req.query.shelf ?? null,
          allShelves,
          host: copyUrl(""),
        })
      );
    }
  );
}
