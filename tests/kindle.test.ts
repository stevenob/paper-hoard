import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeAsin,
  looksLikeKindleAsin,
  readOnKindleUrl,
  lookupKindleAsinFromOpenLibrary,
} from "../src/shared/kindle.js";

// undici.request is hoisted so the kindle module sees the mock.
vi.mock("undici", () => ({
  request: vi.fn(),
}));
import { request } from "undici";
const mockedRequest = request as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, statusCode = 200) {
  return {
    statusCode,
    body: { json: async () => body },
  };
}

describe("normalizeAsin", () => {
  it("accepts a valid Kindle ASIN", () => {
    expect(normalizeAsin("B07ZPC9QD4")).toBe("B07ZPC9QD4");
  });
  it("trims and uppercases", () => {
    expect(normalizeAsin("  b07zpc9qd4  ")).toBe("B07ZPC9QD4");
  });
  it("accepts ISBN-10-shaped values (it's the right shape)", () => {
    expect(normalizeAsin("0593135202")).toBe("0593135202");
  });
  it("rejects too-short values", () => {
    expect(normalizeAsin("B07ZPC9QD")).toBeNull();
  });
  it("rejects non-alphanumeric", () => {
    expect(normalizeAsin("B07ZPC9QD4!")).toBeNull();
    expect(normalizeAsin("B07-ZPC9QD")).toBeNull();
  });
  it("rejects empty string", () => {
    expect(normalizeAsin("")).toBeNull();
  });
  it("rejects non-string input", () => {
    // @ts-expect-error testing runtime guard
    expect(normalizeAsin(null)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(normalizeAsin(undefined)).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(normalizeAsin(12345)).toBeNull();
  });
});

describe("looksLikeKindleAsin", () => {
  it("matches B0-prefixed ASINs", () => {
    expect(looksLikeKindleAsin("B07ZPC9QD4")).toBe(true);
    expect(looksLikeKindleAsin("B08FHBV4ZX")).toBe(true);
  });
  it("does NOT match other B-prefixes (only B0)", () => {
    expect(looksLikeKindleAsin("BX7ZPC9QD4")).toBe(false);
    expect(looksLikeKindleAsin("B17ZPC9QD4")).toBe(false);
  });
  it("does NOT match ISBN-10-shaped values", () => {
    expect(looksLikeKindleAsin("0593135202")).toBe(false);
  });
});

describe("readOnKindleUrl", () => {
  it("builds the Cloud Reader URL", () => {
    expect(readOnKindleUrl("B07ZPC9QD4")).toBe(
      "https://read.amazon.com/kp/kshare?asin=B07ZPC9QD4"
    );
  });
  it("URL-encodes input (defensive — normalizeAsin already filters)", () => {
    expect(readOnKindleUrl("a b")).toBe(
      "https://read.amazon.com/kp/kshare?asin=a%20b"
    );
  });
});

describe("lookupKindleAsinFromOpenLibrary", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the first B0 ASIN when ISBN is verified", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            isbn: ["9780593135204"],
            // Heterogeneous mix from real OL response — the helper
            // must filter to Kindle-shaped values only.
            id_amazon: ["855651121X", "B08GB58KD5", "B08FHBV4ZX"],
          },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBe("B08GB58KD5");
  });

  it("rejects docs whose isbn array does NOT contain the queried ISBN", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            isbn: ["9780000000000"], // unrelated ISBN
            id_amazon: ["B08GB58KD5"],
          },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("walks past unrelated docs to find an ISBN-verified match", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          { isbn: ["9999999999999"], id_amazon: ["B0WRONG999"] },
          {
            isbn: ["9780593135204"],
            id_amazon: ["B08CORRECT"],
          },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBe("B08CORRECT");
  });

  it("returns undefined when id_amazon has no B0 entries", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            isbn: ["9780593135204"],
            id_amazon: ["0593135202", "1234567890"],
          },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("returns undefined when id_amazon is missing entirely", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [{ isbn: ["9780593135204"] }],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("returns undefined when docs is empty", async () => {
    mockedRequest.mockResolvedValue(jsonResponse({ docs: [] }));
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("returns undefined on 5xx", async () => {
    mockedRequest.mockResolvedValue(jsonResponse({}, 503));
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("returns undefined on network error (never throws)", async () => {
    mockedRequest.mockRejectedValue(new Error("ECONNRESET"));
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });

  it("uppercases id_amazon entries before matching (defends against lowercase)", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          {
            isbn: ["9780593135204"],
            id_amazon: ["b08gb58kd5"],
          },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBe("B08GB58KD5");
  });

  it("does not continue past first ISBN-verified doc with no B0 match", async () => {
    // If the first doc verifies the ISBN but has no B0 ASIN, we
    // must NOT pick up an ASIN from a later (potentially unrelated)
    // doc. Better to return nothing than to attach the wrong ASIN.
    mockedRequest.mockResolvedValue(
      jsonResponse({
        docs: [
          { isbn: ["9780593135204"], id_amazon: ["0593135202"] },
          { isbn: ["9780593135204"], id_amazon: ["B08DIFFERENT"] },
        ],
      })
    );
    const result = await lookupKindleAsinFromOpenLibrary("9780593135204");
    expect(result).toBeUndefined();
  });
});
