import type { FastifyInstance } from "fastify";
import { requireUser } from "./_helpers.js";
import { refetchMissingCovers, refreshLowResCovers } from "./_cover-backfill.js";

/**
 * /stats was merged into /about as of v3.5.5. Keep the GET route alive
 * as a redirect so old bookmarks and external links still resolve. The
 * cover-backfill POST endpoints stay where they are because the merged
 * /about view still POSTs to them.
 */
export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats", async (_req, reply) => {
    return reply.redirect("/about", 301);
  });

  // Web-triggered cover backfill. Processes up to N books per call so the
  // client can render progress and the request never hangs for minutes.
  app.post("/stats/backfill-covers", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const result = await refetchMissingCovers(50);
    return reply.send({ ok: true, ...result });
  });

  // Refresh low-resolution covers (Google Books zoom=1, OL -M.jpg, http://)
  // to the higher-quality versions. Same batch + progress contract as the
  // missing-cover endpoint above.
  app.post("/stats/refresh-low-res-covers", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const result = await refreshLowResCovers(50);
    return reply.send({ ok: true, ...result });
  });
}
