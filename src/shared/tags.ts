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

export async function findOrCreateTag(name: string) {
  const cleanName = name.trim().slice(0, 64);
  if (!cleanName) throw new Error("tag name is empty");
  const slug = slugify(cleanName);
  if (!slug) throw new Error("tag name slugifies to empty");
  return prisma.tag.upsert({
    where: { slug },
    create: { name: cleanName, slug },
    update: {},
  });
}
