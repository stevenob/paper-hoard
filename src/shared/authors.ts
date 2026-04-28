import { prisma } from "./db.js";
import { slugify } from "./shelves.js";

export function authorSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = slugify(name);
  return s || null;
}

/**
 * Resolve a slug like "andy-weir" back to the canonical author name(s) it
 * matches in this library. Multiple variants (e.g. "Andy Weir" and "Andy
 * Weir, PhD") may slugify to the same value — return all of them so the
 * caller can show every copy.
 *
 * Returns null if no books in the library match.
 */
export async function resolveAuthorSlug(
  libraryId: string,
  slug: string
): Promise<{ canonical: string; matchingNames: string[] } | null> {
  const distinct = await prisma.book.findMany({
    where: {
      primaryAuthor: { not: null },
      physicalCopies: { some: { libraryId, deletedAt: null } },
    },
    distinct: ["primaryAuthor"],
    select: { primaryAuthor: true },
  });
  const matchingNames = distinct
    .map((r) => r.primaryAuthor!)
    .filter((n) => slugify(n) === slug);
  if (matchingNames.length === 0) return null;
  // Pick the most "presentable" canonical name — the longest one usually
  // includes title suffixes; the shortest is typically what people mean.
  const canonical = [...matchingNames].sort((a, b) => a.length - b.length)[0];
  return { canonical, matchingNames };
}
