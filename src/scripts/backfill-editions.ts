/**
 * Backfill PhysicalCopy.edition for existing rows by re-querying Open Library
 * with the book's ISBN-13. Safe to run multiple times — only touches rows
 * where edition IS NULL and the book has an ISBN.
 *
 * Run on TrueNAS:
 *   sudo docker exec -it ix-paperhoard-web-1 node dist/scripts/backfill-editions.js
 *
 * Options (env):
 *   DRY_RUN=1       Print what would change but don't write to the DB.
 *   SLEEP_MS=200    Delay between Open Library calls (default 200ms).
 *   LIMIT=999999    Cap the number of rows processed in one run.
 */
import "dotenv/config";
import { prisma } from "../shared/db.js";
import { lookupByIsbn } from "../shared/metadata.js";
import { audit } from "../shared/audit.js";

const DRY_RUN = process.env.DRY_RUN === "1";
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 200);
const LIMIT = Number(process.env.LIMIT ?? 999_999);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const candidates = await prisma.physicalCopy.findMany({
    where: { edition: null, book: { isbn13: { not: null } } },
    include: { book: true },
    orderBy: { addedAt: "asc" },
    take: LIMIT,
  });

  console.log(
    `Found ${candidates.length} candidate copies (edition IS NULL, book.isbn13 IS NOT NULL).`
  );
  if (DRY_RUN) console.log("DRY_RUN=1 — no writes will occur.");

  let updated = 0;
  let unknown = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const isbn = c.book.isbn13!;
    const prefix = `[${i + 1}/${candidates.length}]`;
    try {
      const meta = await lookupByIsbn(isbn);
      if (!meta) {
        console.log(`${prefix} ${isbn} ${c.book.title} — no metadata`);
        failed++;
      } else if (!meta.edition) {
        console.log(`${prefix} ${isbn} ${c.book.title} — no binding info`);
        unknown++;
      } else {
        console.log(`${prefix} ${isbn} ${c.book.title} → ${meta.edition}`);
        if (!DRY_RUN) {
          await prisma.physicalCopy.update({
            where: { id: c.id },
            data: { edition: meta.edition },
          });
          void audit({
            action: "update",
            entity: "physicalCopy",
            entityId: c.id,
            details: { source: "backfill-editions", edition: meta.edition },
          });
        }
        updated++;
      }
    } catch (err) {
      console.error(`${prefix} ${isbn} — error:`, err instanceof Error ? err.message : err);
      failed++;
    }
    await sleep(SLEEP_MS);
  }

  console.log("---");
  console.log(`Updated: ${updated}`);
  console.log(`No binding info: ${unknown}`);
  console.log(`Lookup failed: ${failed}`);
  if (DRY_RUN) console.log("(DRY_RUN — no actual writes were made.)");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("backfill-editions failed:", err);
  process.exit(1);
});
