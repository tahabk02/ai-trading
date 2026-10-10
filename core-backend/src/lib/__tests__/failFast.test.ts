// failFast.test.ts
//
// Verifies the production boot guard in secrets.ts: with a broken environment
// the process must die loudly and name every problem, rather than starting
// "successfully" against a SQLite file or a forgeable signing key.

import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { buildSync } from "esbuild";

const SERVICE_ROOT = path.resolve(__dirname, "../../..");

/**
 * Build artifacts MUST live outside the source tree. `ts-node-dev` watches
 * `src/` and respawns the whole server on any change, so a stray .cjs here
 * would restart the running backend once per test and leave it thrashing.
 */
const OUT = path.join(os.tmpdir(), "core-backend-failfast-probe", "secrets.cjs");

/**
 * Boot secrets.ts in a real child process with a controlled environment and
 * return { code, stdout, stderr }.
 */
function boot(env: Record<string, string>, cwd = SERVICE_ROOT) {
  // A pristine env: no inherited DATABASE_URL/JWT_SECRET from the parent shell.
  // Env FILES are skipped so each case controls the complete environment —
  // otherwise the real `core-backend/.env` on disk would quietly supply the very
  // variables a "missing DATABASE_URL" case is trying to omit.
  const base: Record<string, string> = {
    PATH: process.env.PATH || "",
    SYSTEMROOT: process.env.SYSTEMROOT || "",
    COMSPEC: process.env.COMSPEC || "",
    NODE_ENV: "production",
    CORE_BACKEND_SKIP_ENV_FILES: "true",
  };
  try {
    const stdout = execFileSync(process.execPath, [OUT], {
      cwd,
      env: { ...base, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

function build() {
  // The stub also lives outside `src/` for the same ts-node-dev reason.
  const entry = path.join(os.tmpdir(), "core-backend-failfast-probe", "entry.ts");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(
    entry,
    `import { secrets } from ${JSON.stringify(path.join(SERVICE_ROOT, "src", "config", "secrets.ts"))};
console.log("BOOTED " + secrets.DATABASE_URL.slice(0, 8));`,
    "utf8",
  );
  buildSync({
    entryPoints: [entry],
    outfile: OUT,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["dotenv"],
    logLevel: "silent",
  });
}

const GOOD = {
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "0c1f8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
  AI_ENGINE_API_KEY: "a-real-service-key-from-the-secret-store",
};

describe("production boot guard", () => {
  it("boots when the environment is complete", () => {
    build();
    const r = boot(GOOD);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("BOOTED");
  });

  it("refuses to boot with a SQLite DATABASE_URL", () => {
    build();
    const r = boot({ ...GOOD, DATABASE_URL: "file:./dev.db" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("refuses to boot with a missing DATABASE_URL", () => {
    build();
    const r = boot({ JWT_SECRET: GOOD.JWT_SECRET, AI_ENGINE_API_KEY: GOOD.AI_ENGINE_API_KEY });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("refuses to boot with a placeholder JWT_SECRET", () => {
    build();
    const r = boot({ ...GOOD, JWT_SECRET: "change-me" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("JWT_SECRET");
  });

  it("refuses to boot with a too-short JWT_SECRET", () => {
    build();
    const r = boot({ ...GOOD, JWT_SECRET: "short-but-not-a-placeholder" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/JWT_SECRET/);
    expect(r.stderr).toMatch(/32 characters/);
  });

  it("refuses to boot without AI_ENGINE_API_KEY", () => {
    build();
    const r = boot({ DATABASE_URL: GOOD.DATABASE_URL, JWT_SECRET: GOOD.JWT_SECRET });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("AI_ENGINE_API_KEY");
  });

  it("reports EVERY problem at once, not just the first", () => {
    build();
    // Nothing valid at all: the operator should learn all three in one restart.
    const r = boot({});
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("DATABASE_URL");
    expect(r.stderr).toContain("JWT_SECRET");
    expect(r.stderr).toContain("AI_ENGINE_API_KEY");
    expect(r.stderr).toMatch(/3 required environment variable/);
  });

  it("never prints a secret value in the failure output", () => {
    build();
    const secret = "super-secret-value-that-must-never-be-logged";
    const r = boot({ ...GOOD, JWT_SECRET: "x".repeat(8), AI_ENGINE_API_KEY: secret });
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain(secret);
    expect(r.stderr).not.toContain("xxxx");
    // The database password must not be echoed either.
    const withPw = boot({ ...GOOD, DATABASE_URL: "file:./dev.db" });
    expect(withPw.stderr).not.toContain("postgresql://u:p@");
  });

  it("behaves identically from the repo root (cwd-independent)", () => {
    build();
    const fromService = boot({ ...GOOD, DATABASE_URL: "file:./dev.db" });
    const fromRepo = boot({ ...GOOD, DATABASE_URL: "file:./dev.db" }, path.resolve(SERVICE_ROOT, ".."));
    expect(fromRepo.code).not.toBe(0);
    expect(fromRepo.stderr).toContain("DATABASE_URL");
    expect(fromService.stderr).toContain("DATABASE_URL");
  });

  afterAll(() => {
    fs.rmSync(path.join(os.tmpdir(), "core-backend-failfast-probe"), {
      recursive: true,
      force: true,
    });
  });
});
