import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/web/index.js";
import { prisma } from "../src/shared/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let app: FastifyInstance;

beforeAll(async () => {
  // Seed a minimal library so /library/labels and exports succeed instead
  // of falling through the "no library" guards. Each test file gets a
  // clean library upserted by guildId.
  await prisma.library.upsert({
    where: { discordGuildId: "test-guild" },
    create: { discordGuildId: "test-guild", name: "Test Library" },
    update: { name: "Test Library" },
  });

  app = await buildApp({
    viewsRoot: path.join(repoRoot, "src", "web", "views"),
    publicRoot: path.join(repoRoot, "src", "web", "public"),
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/**
 * Smoke test: every public GET route should return either 200 or a
 * documented redirect/404. Never 500. Catches regressions in template
 * rendering, missing route registration, and broken Prisma queries.
 */
describe("GET smoke tests", () => {
  const cases: Array<[string, number[]]> = [
    ["/healthz", [200]],
    ["/", [200]],
    ["/library", [200]],
    ["/library/dupes", [200]],
    ["/library/labels", [200]],
    ["/scan", [200]],
    ["/scan/cache.json", [200]],
    ["/stats", [200]],
    ["/trophies", [200]],
    ["/completions", [200]],
    ["/users", [200]],
    ["/import", [200]],
    ["/about", [200]],
    ["/shelves", [200]],
    ["/audit", [200]],
    ["/search", [200]],
    ["/trash", [200]],
    ["/library/export.csv", [200]],
    ["/library/export.json", [200]],
    ["/library/backups.json", [200]],
    // Unknown author slug returns a well-formed 404, not a crash.
    ["/authors/nobody-with-this-slug", [404]],
  ];
  for (const [url, expected] of cases) {
    it(`${url} -> ${expected.join(" or ")}`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(expected).toContain(res.statusCode);
    });
  }
});

describe("POST guards", () => {
  it("/scan requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/scan",
      payload: { isbn: "9780000000007" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("/scan/lookup requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/scan/lookup",
      payload: { isbn: "9780000000007" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("/library/bulk-edit requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/library/bulk-edit",
      payload: { action: "trash", copyIds: ["any"] },
    });
    expect(res.statusCode).toBe(401);
  });
});
