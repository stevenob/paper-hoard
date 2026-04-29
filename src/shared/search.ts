import { prisma } from "./db.js";

/**
 * Fuzzy-search Book IDs by title or primary author using Postgres pg_trgm
 * similarity. Falls back to ILIKE substring for short queries (≤3 chars)
 * since the trigram threshold needs at least one full trigram to match.
 *
 * Returns up to 500 IDs ranked by relevance — the caller is expected to
 * apply its own sort + pagination on top.
 */
export async function fuzzyMatchingBookIds(query: string): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];

  // Short queries skip the trigram path because pg_trgm needs ≥3 chars to
  // form a meaningful trigram. For these, ILIKE substring is sufficient.
  if (q.length < 4) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Book"
      WHERE title ILIKE ${"%" + q + "%"}
         OR "primaryAuthor" ILIKE ${"%" + q + "%"}
         OR ${q} = ANY(authors)
      LIMIT 500
    `;
    return rows.map((r) => r.id);
  }

  // Trigram + ILIKE union, ranked by best similarity score so close matches
  // appear first when the caller honors order. Authors[] is also matched so
  // queries like "andy weir" still find books even when primaryAuthor was
  // populated as "Andy Weir, PhD".
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Book"
    WHERE title ILIKE ${"%" + q + "%"}
       OR "primaryAuthor" ILIKE ${"%" + q + "%"}
       OR title % ${q}
       OR "primaryAuthor" % ${q}
       OR EXISTS (
         SELECT 1 FROM unnest(authors) a WHERE a ILIKE ${"%" + q + "%"} OR a % ${q}
       )
    ORDER BY GREATEST(
      similarity(title, ${q}),
      COALESCE(similarity("primaryAuthor", ${q}), 0)
    ) DESC
    LIMIT 500
  `;
  return rows.map((r) => r.id);
}
