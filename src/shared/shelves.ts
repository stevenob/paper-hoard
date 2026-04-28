import { prisma } from "./db.js";

const SLUGIFY_RE = /[^a-z0-9]+/g;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(SLUGIFY_RE, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Find an existing shelf by slug within a library or create a new one.
 * Used everywhere a shelf name is accepted as free text.
 */
export async function findOrCreateShelf(libraryId: string, name: string) {
  const cleanName = name.trim().slice(0, 100);
  if (!cleanName) throw new Error("shelf name is empty");
  const slug = slugify(cleanName);
  if (!slug) throw new Error("shelf name slugifies to empty");
  return prisma.shelf.upsert({
    where: { libraryId_slug: { libraryId, slug } },
    create: { libraryId, name: cleanName, slug },
    update: {},
  });
}

export async function listShelves(libraryId: string) {
  return prisma.shelf.findMany({
    where: { libraryId },
    orderBy: [{ isOrdered: "desc" }, { name: "asc" }],
  });
}
