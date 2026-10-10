import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/lib/__tests__/**/*.test.ts"],
    environment: "node",
    // `failFast.test.ts` boots the real config in ~4.5s of child processes, and
    // the prediction suites already sit near the 5s default. Running files
    // sequentially keeps a loaded machine from pushing those over the limit —
    // a timeout here would read as a product regression when it is only
    // scheduler contention. The suite is ~20s this way.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});