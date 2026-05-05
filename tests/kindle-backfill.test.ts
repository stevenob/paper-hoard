/**
 * DB-backed tests for the /stats/backfill-kindle-asins helper.
 * Same Postgres requirement as the other DB-touching test files.
 *
 * The OL HTTP layer is stubbed via the `kindle.js` module mock so
 * we test the backfill orchestration end-to-end without external
 * dependencies. The enrichKindleAsin internals are exercised
 * transitively (the backfill helper calls it).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "../src/shared/db.js";

vi.mock("../src/shared/kindle.js", async (orig) => {
  const real = await orig<typeof import("../src/shared/kindle.js")>();
  return {
    ...real,
    lookupKindleAsinDetailed: vi.fn(),
    lookupKindleAsinFromOpenLibrary: vi.fn(),
  };
});
import { lookupKindleAsinDetailed } from "../src/shared/kindle.js";
import { backfillKindleAsins } from "../src/web/routes/_kindle-backfill.js";

const mockedLookup = lookupKindleAsinDetailed as unknown as ReturnType<
  typeof vi.fn
>;

function detailedReturn(value: string | null | undefined) {
  if (typeof value === "string") {
    return { kind: "found" as const, asin: value };
  }
  if (value === null) {
    return { kind: "error" as const, cause: "network" as const };
  }
  return { kind: "no-match" as const };
}

let libraryId: string;
let userId: string;

async function makeBookWithCopy(opts: {
  isbn13?: string;
  kindleAsin?: string | null;
  kindleAsinSource?: string | null;
  kindleAsinAttemptedAt?: Date | null;
}): Promise<string> {
  const isbn =
    opts.isbn13 ??
    "978" + Math.floor(Math.random() * 1e10).toString().padStart(10, "0");
  const book = await prisma.book.create({
    data: {
      title: "Backfill Test " + Math.random().toString(36).slice(2, 8),
      authors: ["Author"],
      primaryAuthor: "Author",
      isbn13: isbn,
      kindleAsin: opts.kindleAsin ?? null,
      kindleAsinSource: opts.kindleAsinSource ?? null,
      kindleAsinAttemptedAt: opts.kindleAsinAttemptedAt ?? null,
    },
  });
  await prisma.physicalCopy.create({
    data: {
      bookId: book.id,
      libraryId,
      addedByUserId: userId,
    },
  });
  return book.id;
}

beforeAll(async () => {
  const lib = await prisma.library.upsert({
    where: { discordGuildId: "test-guild-kindle-backfill" },
    create: {
      discordGuildId: "test-guild-kindle-backfill",
      name: "Kindle Backfill Test Library",
    },
    update: { name: "Kindle Backfill Test Library" },
  });
  libraryId = lib.id;
  const user = await prisma.user.upsert({
    where: { discordUserId: "test-user-kindle-backfill" },
    create: {
      discordUserId: "test-user-kindle-backfill",
      displayName: "Backfill Tester",
    },
    update: {},
  });
  userId = user.id;
}, 30_000);

afterAll(async () => {
  // Tear down test fixtures so re-runs don't accumulate. Delete in
  // FK-safe order: PhysicalCopy → AuditLog → Book → Library/User.
  // PhysicalCopies in BOTH the test library and the other-lib used
  // by the cross-library test must be cleaned up before the books.
  const testBookIds = (
    await prisma.book.findMany({
      where: { title: { startsWith: "Backfill Test " } },
      select: { id: true },
    })
  ).map((r) => r.id);
  if (testBookIds.length > 0) {
    await prisma.physicalCopy.deleteMany({
      where: { bookId: { in: testBookIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { entity: "book", entityId: { in: testBookIds } },
    });
    await prisma.book.deleteMany({ where: { id: { in: testBookIds } } });
  }
  await prisma.library.deleteMany({
    where: { discordGuildId: { in: ["test-guild-other"] } },
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedLookup.mockReset();
});

describe("backfillKindleAsins", () => {
  it("processes only books in the caller's library", async () => {
    mockedLookup.mockResolvedValue(detailedReturn("B0BACKFILL1"));
    const inScope = await makeBookWithCopy({});
    // Out-of-scope: a book with no copy in our library.
    const otherLib = await prisma.library.upsert({
      where: { discordGuildId: "test-guild-other" },
      create: { discordGuildId: "test-guild-other", name: "Other" },
      update: {},
    });
    await prisma.book.create({
      data: {
        title: "Backfill Test other-lib",
        authors: ["Z"],
        isbn13:
          "978" + Math.floor(Math.random() * 1e10).toString().padStart(10, "0"),
        physicalCopies: {
          create: {
            libraryId: otherLib.id,
            addedByUserId: userId,
          },
        },
      },
    });

    const result = await backfillKindleAsins(50, { libraryId });
    const inScopeRow = result.results.find((r) => r.bookId === inScope);
    expect(inScopeRow?.action).toBe("repaired");
    expect(inScopeRow?.detail).toContain("B0BACKFILL1");
    // No row from the other library should appear.
    expect(
      result.results.find((r) => r.title === "Backfill Test other-lib")
    ).toBeUndefined();
  });

  it("respects manual ASINs (excluded by candidate query)", async () => {
    mockedLookup.mockResolvedValue(detailedReturn("B0SHOULDNTSEE"));
    const id = await makeBookWithCopy({
      kindleAsin: "B0MANUAL0000",
      kindleAsinSource: "manual",
    });
    const result = await backfillKindleAsins(50, { libraryId });
    expect(result.results.find((r) => r.bookId === id)).toBeUndefined();
    expect(mockedLookup).not.toHaveBeenCalledWith(expect.anything());
  });

  it("respects the 7-day cooldown by default", async () => {
    mockedLookup.mockResolvedValue(detailedReturn("B0COOLDOWN00"));
    const recent = await makeBookWithCopy({
      kindleAsinAttemptedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    const result = await backfillKindleAsins(50, { libraryId });
    expect(result.results.find((r) => r.bookId === recent)).toBeUndefined();
  });

  it("ignoreCooldown=true picks up books in cooldown", async () => {
    mockedLookup.mockResolvedValue(detailedReturn("B0RETRYORPHN"));
    const recent = await makeBookWithCopy({
      kindleAsinAttemptedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    const result = await backfillKindleAsins(50, {
      libraryId,
      ignoreCooldown: true,
    });
    const row = result.results.find((r) => r.bookId === recent);
    expect(row?.action).toBe("repaired");
    expect(row?.detail).toContain("B0RETRYORPHN");
  });

  it("reports a 'failed' row with no Kindle ASIN at OL", async () => {
    mockedLookup.mockResolvedValue(detailedReturn(undefined));
    const id = await makeBookWithCopy({});
    const result = await backfillKindleAsins(50, { libraryId });
    const row = result.results.find((r) => r.bookId === id);
    expect(row?.action).toBe("failed");
    expect(row?.detail).toBe("no Kindle ASIN at OL");
  });

  it("reports a transient OL error distinctly from a coverage gap", async () => {
    // Simulate OL rate-limiting / network drop. The backfill activity
    // log MUST distinguish this from "no ASIN exists" so the user
    // knows to hit "↻ Retry orphans" rather than chase a phantom
    // coverage gap. (This was the v3.6.1→v3.6.2 fix: ECONNRESET errors
    // were being reported as "no Kindle ASIN at OL".)
    mockedLookup.mockResolvedValue({ kind: "error", cause: "network" });
    const id = await makeBookWithCopy({});
    const result = await backfillKindleAsins(50, { libraryId });
    const row = result.results.find((r) => r.bookId === id);
    expect(row?.action).toBe("failed");
    expect(row?.detail).toMatch(/OL request failed/);
    expect(row?.detail).toMatch(/network|rate-limit/);
  });

  it("paces requests with a per-book delay", async () => {
    // Backfill awaits enrichKindleAsin in a tight loop; without a
    // delay between calls, OL rate-limits paper-hoard's IP and most
    // requests fail. Verify the helper actually waits between books.
    mockedLookup.mockResolvedValue(detailedReturn("B0PACEDCALL"));
    await Promise.all([makeBookWithCopy({}), makeBookWithCopy({})]);
    const before = Date.now();
    await backfillKindleAsins(50, { libraryId });
    const elapsed = Date.now() - before;
    // Two books → at least one inter-book sleep (skipped after last).
    // 350ms delay constant; allow some slack for test machine variance.
    // We just want to assert "noticeably > 0", not the exact ms.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  });

  it("returns processed/updated/remaining counts", async () => {
    mockedLookup.mockResolvedValueOnce(detailedReturn("B0PROC000001"));
    mockedLookup.mockResolvedValueOnce(detailedReturn("B0PROC000002"));
    mockedLookup.mockResolvedValueOnce(detailedReturn(undefined)); // miss
    await Promise.all([
      makeBookWithCopy({}),
      makeBookWithCopy({}),
      makeBookWithCopy({}),
    ]);
    const result = await backfillKindleAsins(50, { libraryId });
    // We can't assert exactly 3 because earlier tests in the same
    // file added books too; we assert >= 3 and that updated reflects
    // the two successful mocks for our just-added rows.
    expect(result.processed).toBeGreaterThanOrEqual(3);
    expect(result.updated).toBeGreaterThanOrEqual(2);
    // After processing this batch with all candidates exhausted (the
    // claim stamps kindleAsinAttemptedAt for failures too), the next
    // run with the same scope should find zero remaining.
    expect(result.remaining).toBe(0);
  });
});
