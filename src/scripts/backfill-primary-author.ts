/**
 * Backfill Book.primaryAuthor for existing rows whose value is NULL.
 * The migration handles the initial backfill from the authors[] array,
 * but books created via paths that bypass upsertBookFromMetadata (e.g.
 * older imports) might have null. Safe to run repeatedly.
 *
 * Run on TrueNAS:
 *   sudo docker exec -it ix-paperhoard-web-1 node dist/scripts/backfill-primary-author.js
 */
import "dotenv/config";
import { prisma } from "../shared/db.js";

async function main() {
  const candidates = await prisma.book.findMany({
    where: { primaryAuthor: null },
    select: { id: true, title: true, authors: true },
  });
  console.log(`Found ${candidates.length} books with null primaryAuthor.`);
  let updated = 0;
  for (const b of candidates) {
    const first = b.authors[0];
    if (!first) continue;
    await prisma.book.update({
      where: { id: b.id },
      data: { primaryAuthor: first },
    });
    updated++;
  }
  console.log(`Updated ${updated}.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
