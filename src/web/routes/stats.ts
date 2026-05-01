import type { FastifyInstance } from "fastify";
import { getCurrentLibrary, requireUser } from "./_helpers.js";
import { refetchMissingCovers, refreshLowResCovers } from "./_cover-backfill.js";
import { fillMissingAuthors } from "./_author-backfill.js";

/**
 * /stats was merged into /about as of v3.5.5. Keep the GET route alive
 * as a redirect so old bookmarks and external links still resolve. The
 * cover-backfill POST endpoints stay where they are because the merged
 * /about view still POSTs to them.
 *
 * As of v3.5.10, repair helpers are scoped to the caller's library so
 * the in-panel progress total matches the count surfaced on /about.
 * (Without scoping, they swept across every Book row in the DB —
 * including books with copies in other libraries — and the progress
 * total wildly outran the "books missing covers: N" count.)
 */
export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats", async (_req, reply) => {
    return reply.redirect("/about", 301);
  });

  app.post("/stats/backfill-covers", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    const result = await refetchMissingCovers(50, { libraryId: library?.id ?? null });
    return reply.send({ ok: true, ...result });
  });

  app.post("/stats/refresh-low-res-covers", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    const result = await refreshLowResCovers(50, { libraryId: library?.id ?? null });
    return reply.send({ ok: true, ...result });
  });

  app.post("/stats/fill-missing-authors", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const library = await getCurrentLibrary(req);
    const result = await fillMissingAuthors(25, { libraryId: library?.id ?? null });
    return reply.send({ ok: true, ...result });
  });
}
