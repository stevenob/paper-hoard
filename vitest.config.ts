import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests share a real Postgres + Prisma client so run serially.
    fileParallelism: false,
  },
});
