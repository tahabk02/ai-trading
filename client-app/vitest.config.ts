import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const alias = { "@": path.resolve(__dirname, "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        // ── Project 1: the existing pure-logic suite. Effect-equivalent to the
        //    pre-split config: same include glob, same `node` environment, no
        //    setup files, no plugins. 23 files / 414 tests must stay green.
        resolve: { alias },
        test: {
          name: "logic",
          include: ["src/lib/__tests__/**/*.test.ts"],
          environment: "node",
          // This dev host runs the full 58-file suite with setup/collect
          // measured in the hundreds of seconds (disk-starved). File-scanning
          // tests that take ~2.5s isolated intermittently blow the 5s default.
          testTimeout: 30_000,
        },
      },
      {
        // ── Project 2: new DOM/component suite. Additive only — it cannot
        //    change how project 1 collects or runs.
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "ui",
          include: ["src/**/__tests__/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./src/test/setup/ui.setup.ts"],
          // clearMocks, NOT restoreMocks: `restoreMocks` calls mockRestore(),
          // which strips implementations (e.g. .mockResolvedValue) from any
          // vi.fn() created inside a vi.mock() factory — the stub then returns
          // undefined at call time. clearMocks only clears call history.
          clearMocks: true,
          // See the logic project: the default 5s is too tight for the full
          // suite on this disk-starved host (the 44-card registry mount is
          // ~1.8s isolated but ~7s under contention).
          testTimeout: 30_000,
        },
      },
    ],
  },
});
