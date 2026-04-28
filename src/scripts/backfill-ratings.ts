/**
 * Backfill Open Library rating + work id for all Books with an ISBN-13.
 * Safe to re-run — only refreshes rows where olFetchedAt is null or older
 * than the staleness threshold (default 7 days).
 *
 * Run on TrueNAS:
 *   sudo docker exec -it ix-paperhoard-web-1 node dist/scripts/backfill-ratings.js
 *
 * Options (env):
 *   DRY_RUN=1       Print what would change but don't write to the DB.
 *   SLEEP_MS=200    Delay between Open Library calls (default 200ms).
 *   LIMIT=999999    Cap the number of rows processed in one run.
 *   FORCE=1         Refresh even if olFetchedAt is recent.
 */
import "dotenv/config";
import { prisma } from "../shared/db.js";
import { isStale, refreshOpenLibraryRatings } from "../shared/openlibrary-ratings.js";

const DRY_RUN = process.env.DRY_RUN === "1";
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 200);
const LIMIT = Number(process.env.LIMIT ?? 999_999);
const FORCE = process.env.FORCE === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const candidates = await prisma.book.findMany({
    where: { isbn13: { not: null } },
    orderBy: { createdAt: "asc" },
    take: LIMIT,
  });

  const needs = FORCE
    ? candidates
    : candidates.filter((b) => isStale(b.olFetchedAt));

  console.log(
    `Found ${needs.length} of ${candidates.length} books needing a refresh ` +
      `(FORCE=${FORCE ? "on" : "off"}).`
  );
  if (DRY_RUN) {
    console.log("DRY_RUN=1 — no writes will occur.");
    needs.forEach((b, i) =>
      console.log(`[${i + 1}/${needs.length}] ${b.isbn13} ${b.title}`)
    );
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (let i = 0; i < needs.length; i++) {
    const b = needs[i];
    const prefix = `[${i + 1}/${needs.length}]`;
    try {
      const before = b.olRatingAvg;
      await refreshOpenLibraryRatings(b.id);
      const after = await prisma.book.findUnique({
        where: { id: b.id },
        select: { olRatingAvg: true, olRatingCount: true },
      });
      if (after?.olRatingAvg !== null && after?.olRatingAvg !== undefined) {
        console.log(
          `${prefix} ${b.isbn13} ${b.title} → ⭐ ${after.olRatingAvg.toFixed(2)} (${after.olRatingCount})`
        );
        updated++;
      } else if (before !== null) {
        console.log(`${prefix} ${b.isbn13} ${b.title} — refreshed (no rating found)`);
        unchanged++;
      } else {
        console.log(`${prefix} ${b.isbn13} ${b.title} — no rating on Open Library`);
        unchanged++;
      }
    } catch (err) {
      console.error(`${prefix} ${b.isbn13} — error:`, err instanceof Error ? err.message : err);
      failed++;
    }
    await sleep(SLEEP_MS);
  }

  console.log("---");
  console.log(`Updated with rating: ${updated}`);
  console.log(`No rating available: ${unchanged}`);
  console.log(`Lookup failed: ${failed}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("backfill-ratings failed:", err);
  process.exit(1);
});
