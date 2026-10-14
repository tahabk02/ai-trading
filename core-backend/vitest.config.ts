import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/lib/__tests__/**/*.test.ts"],
    environment: "node",
    // PART 49 [516] — hermetic environment: the suite must run with NO `.env`
    // on disk and no ambient system variables. This setup file injects in-memory
    // fallback config BEFORE any test module import.
    setupFiles: ["./vitest.setup.ts"],
    // The unit suite is the explicit "mock/test" posture: it must run without a
    // real deployment secret, so the strict boot guard
    // (`assertRequiredConfig` in src/config/secrets.ts) is opted out here via
    // its one escape hatch. `failFast.test.ts` still exercises the strict path
    // because it boots `secrets.ts` in CHILD processes with a controlled
    // environment that deliberately omits this flag.
    env: { ALLOW_INSECURE_DEV_DEFAULTS: "true" },
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