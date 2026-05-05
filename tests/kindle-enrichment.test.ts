/**
 * DB-backed tests for Kindle ASIN enrichment.
 *
 * Like tests/smoke.test.ts these require a running Postgres reachable
 * via DATABASE_URL. The enrichment module is exercised end-to-end
 * against a real Prisma client; only the Open Library HTTP call is
 * stubbed (we mock the kindle module's `lookupKindleAsinFromOpenLibrary`
 * export so the enrichment behaviour is testable without external
 * dependencies).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "../src/shared/db.js";

// Stub the Open Library lookup. Tests reset and re-arm this between
// cases. The enrichment module imports from "./kindle.js" so the
// path here must match that import specifier exactly.
vi.mock("../src/shared/kindle.js", async (orig) => {
  const real = await orig<typeof import("../src/shared/kindle.js")>();
  return {
    ...real,
    lookupKindleAsinDetailed: vi.fn(),
    lookupKindleAsinFromOpenLibrary: vi.fn(),
  };
});
import {
  lookupKindleAsinDetailed,
  lookupKindleAsinFromOpenLibrary,
} from "../src/shared/kindle.js";
import { enrichKindleAsin } from "../src/shared/kindle-enrichment.js";

const mockedLookup = lookupKindleAsinDetailed as unknown as ReturnType<typeof vi.fn>;
// Some tests in this file are written against the older "returns a string"
// signature; we keep the legacy mock around but every test below was
// updated to drive the detailed mock instead.
void lookupKindleAsinFromOpenLibrary;

/** Test helper: write the legacy "string-or-undefined" semantics in
 *  terms of the new detailed shape so the existing tests stay
 *  compact. `null` denotes a network/HTTP error. */
function detailedReturn(value: string | null | undefined) {
  if (typeof value === "string") {
    mockedLookup.mockResolvedValue({ kind: "found", asin: value });
  } else if (value === null) {
    mockedLookup.mockResolvedValue({ kind: "error", cause: "network" });
  } else {
    mockedLookup.mockResolvedValue({ kind: "no-match" });
  }
}

let libraryId: string;

async function makeBook(opts: {
  isbn13?: string | null;
  kindleAsin?: string | null;
  kindleAsinSource?: string | null;
  kindleAsinAttemptedAt?: Date | null;
}): Promise<string> {
  // Each book gets a unique generated ISBN-13 to avoid collisions
  // across re-runs of the same test file (the column is @unique).
  // Caller can still pass null explicitly to test the no-ISBN path.
  let isbn = opts.isbn13;
  if (isbn === undefined) {
    isbn = "978" + Math.floor(Math.random() * 1e10).toString().padStart(10, "0");
  }
  const book = await prisma.book.create({
    data: {
      title: "Test Book " + Math.random().toString(36).slice(2, 8),
      authors: ["Test Author"],
      isbn13: isbn,
      kindleAsin: opts.kindleAsin ?? null,
      kindleAsinSource: opts.kindleAsinSource ?? null,
      kindleAsinAttemptedAt: opts.kindleAsinAttemptedAt ?? null,
    },
  });
  return book.id;
}

beforeAll(async () => {
  const lib = await prisma.library.upsert({
    where: { discordGuildId: "test-guild-kindle" },
    create: { discordGuildId: "test-guild-kindle", name: "Kindle Test Library" },
    update: { name: "Kindle Test Library" },
  });
  libraryId = lib.id;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  mockedLookup.mockReset();
});

describe("enrichKindleAsin", () => {
  it("populates kindleAsin from OL on a fresh book", async () => {
    detailedReturn("B07ZPC9QD4");
    const id = await makeBook({});
    await enrichKindleAsin(id);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBe("B07ZPC9QD4");
    expect(after?.kindleAsinSource).toBe("open_library");
    expect(after?.kindleAsinAttemptedAt).not.toBeNull();
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a manual ASIN — claim short-circuits before HTTP", async () => {
    detailedReturn("B0NEW000000");
    const id = await makeBook({
      kindleAsin: "B0OLD000000",
      kindleAsinSource: "manual",
    });
    await enrichKindleAsin(id);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBe("B0OLD000000");
    expect(after?.kindleAsinSource).toBe("manual");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("replaces an OL-sourced ASIN with a newer OL value", async () => {
    detailedReturn("B0NEWVALUE0");
    const id = await makeBook({
      kindleAsin: "B0OLDVALUE0",
      kindleAsinSource: "open_library",
      kindleAsinAttemptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await enrichKindleAsin(id);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBe("B0NEWVALUE0");
    expect(after?.kindleAsinSource).toBe("open_library");
  });

  it("does not call OL when within the 7-day cooldown", async () => {
    detailedReturn("B07ZPC9QD4");
    const id = await makeBook({
      kindleAsinAttemptedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    await enrichKindleAsin(id);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("calls OL when the cooldown has expired", async () => {
    detailedReturn("B07ZPC9QD4");
    const id = await makeBook({
      kindleAsinAttemptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await enrichKindleAsin(id);
    expect(mockedLookup).toHaveBeenCalledTimes(1);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBe("B07ZPC9QD4");
  });

  it("does not call OL when the book has no ISBN-13", async () => {
    detailedReturn("B07ZPC9QD4");
    const id = await makeBook({ isbn13: null });
    await enrichKindleAsin(id);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("writes no audit row on a same-value refresh", async () => {
    detailedReturn("B0SAMEVALUE");
    const id = await makeBook({
      kindleAsin: "B0SAMEVALUE",
      kindleAsinSource: "open_library",
      kindleAsinAttemptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const beforeAuditCount = await prisma.auditLog.count({
      where: { entity: "book", entityId: id },
    });
    await enrichKindleAsin(id);
    const afterAuditCount = await prisma.auditLog.count({
      where: { entity: "book", entityId: id },
    });
    expect(afterAuditCount).toBe(beforeAuditCount);
    // Cooldown still got bumped though.
    const after = await prisma.book.findUnique({ where: { id } });
    expect(
      Date.now() - (after?.kindleAsinAttemptedAt?.getTime() ?? 0)
    ).toBeLessThan(60_000);
  });

  it("writes one audit row when an OL value actually changes", async () => {
    detailedReturn("B0NEWAUDIT0");
    const id = await makeBook({
      kindleAsin: "B0OLDAUDIT0",
      kindleAsinSource: "open_library",
      kindleAsinAttemptedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const beforeAuditCount = await prisma.auditLog.count({
      where: { entity: "book", entityId: id },
    });
    await enrichKindleAsin(id);
    const afterAuditCount = await prisma.auditLog.count({
      where: { entity: "book", entityId: id },
    });
    expect(afterAuditCount).toBe(beforeAuditCount + 1);
  });

  it("concurrent calls for the same book → only one HTTP request", async () => {
    let resolveLookup: ((v: { kind: "found"; asin: string }) => void) | null = null;
    mockedLookup.mockImplementation(
      () =>
        new Promise<{ kind: "found"; asin: string }>((resolve) => {
          resolveLookup = resolve;
        })
    );
    const id = await makeBook({});
    // Fire two enrichments before either claim's followup HTTP call
    // can complete. The atomic claim should serialise them — only
    // the first acquires the cooldown stamp; the second exits early.
    const p1 = enrichKindleAsin(id);
    // Yield once so the first claim definitely lands before the
    // second one runs its updateMany.
    await new Promise((r) => setImmediate(r));
    const p2 = enrichKindleAsin(id);
    // p2 should have already short-circuited before reaching the
    // mocked lookup. Wait for it explicitly.
    await p2;
    // Now release the in-flight HTTP call and let the first finish.
    resolveLookup?.({ kind: "found", asin: "B0CONCURRENT" });
    await p1;
    expect(mockedLookup).toHaveBeenCalledTimes(1);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBe("B0CONCURRENT");
  });

  it("returns gracefully when OL says nothing — only cooldown is stamped", async () => {
    detailedReturn(undefined);
    const id = await makeBook({});
    await enrichKindleAsin(id);
    const after = await prisma.book.findUnique({ where: { id } });
    expect(after?.kindleAsin).toBeNull();
    expect(after?.kindleAsinAttemptedAt).not.toBeNull();
  });
});

// Suppress lint: libraryId is exported for cross-file fixture sharing
// if needed later, but the current test file uses it only locally.
export { libraryId };
