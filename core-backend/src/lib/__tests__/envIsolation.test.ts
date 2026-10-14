/**
 * envIsolation.test.ts
 *
 * Regression tests for the configuration-shadowing defect.
 *
 * The bug: `secrets.ts` loaded `dotenv.config({ path: "../.env" })`, which is
 * resolved against `process.cwd()`. From `core-backend/` that is the REPO-ROOT
 * `.env`. Since dotenv is first-wins (`override: false`), the root file was
 * authoritative for all seven keys it shares with core-backend, and its SQLite
 * `DATABASE_URL=file:./dev.db` silently beat core-backend's Postgres one.
 *
 * These tests assert the three properties that make that impossible to
 * reintroduce: no parent leakage, no cwd dependence, and real-environment
 * precedence.
 *
 * PART 49 [516] — HERMETIC: this suite no longer requires a real
 * `core-backend/.env` or repo-root `.env` on disk. It builds its OWN fixture
 * tree under the OS temp dir and drives the loader's pure core
 * (`loadEnvFromRoot`) into an in-memory object, so it runs identically in a
 * clean checkout and on a fully-configured developer machine.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  SERVICE_ROOT,
  candidateEnvFiles,
  loadEnvFromRoot,
  isConfigured,
  describeEnvSources,
} from "../../config/env";

// ── the hermetic fixture tree ───────────────────────────────────────────────
// Structure mirrors the real repo: <tmp>/.env  (parent) and
// <tmp>/core-backend/.env (the service that must win).
let TMP_ROOT = "";
let SERVICE_DIR = "";
let PARENT_FILE = "";
let SERVICE_FILE = "";

const SERVICE_VALUES = {
  DATABASE_URL: "postgresql://svc:pw@localhost:5433/service_db",
  JWT_SECRET: "service-jwt-secret-00000000000000000000000000000000",
  AI_ENGINE_API_KEY: "service-ai-engine-key-000000000000000000000000000",
};

const PARENT_VALUES = {
  DATABASE_URL: "file:./dev.db", // the exact shadowing value from the bug
  JWT_SECRET: "parent-jwt-secret-111111111111111111111111111111111",
  AI_ENGINE_API_KEY: "parent-ai-engine-key-1111111111111111111111111111",
};

function writeEnv(file: string, values: Record<string, string>): void {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(file, body + "\n", "utf8");
}

beforeAll(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "h516-env-isolation-"));
  SERVICE_DIR = path.join(TMP_ROOT, "core-backend");
  fs.mkdirSync(SERVICE_DIR, { recursive: true });
  PARENT_FILE = path.join(TMP_ROOT, ".env");
  SERVICE_FILE = path.join(SERVICE_DIR, ".env");
  writeEnv(PARENT_FILE, PARENT_VALUES);
  writeEnv(SERVICE_FILE, SERVICE_VALUES);
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("env isolation: service root resolution", () => {
  it("resolves the service root from the module, not the cwd", () => {
    // `SERVICE_ROOT` is derived from `__dirname` inside env.ts. Here `__dirname`
    // is `<service>/src/lib/__tests__`, so three levels up is the service root,
    // and its basename must be `core-backend` — independent of where the test
    // process was launched from.
    expect(SERVICE_ROOT).toBe(path.resolve(__dirname, "../../.."));
    expect(path.basename(SERVICE_ROOT)).toBe("core-backend");
    expect(fs.existsSync(path.join(SERVICE_ROOT, "src", "config", "env.ts"))).toBe(
      true,
    );
  });

  it("loads service-local files only, and never the repository-root .env", () => {
    const scratch: NodeJS.ProcessEnv = {};
    const loaded = loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });

    // The parent file genuinely exists in the fixture — that is what made the
    // original bug dangerous rather than theoretical.
    expect(fs.existsSync(PARENT_FILE)).toBe(true);

    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded).not.toContain(PARENT_FILE);

    for (const f of loaded) {
      const rel = path.relative(SERVICE_DIR, f);
      // A leading ".." would mean we read a parent's file.
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("is idempotent", () => {
    const scratch: NodeJS.ProcessEnv = {};
    const first = loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });
    const second = loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });
    expect(second).toEqual(first);
    // override:false — a second load never rewrites the already-set values.
    expect(scratch.DATABASE_URL).toBe(SERVICE_VALUES.DATABASE_URL);
  });
});

describe("env isolation: the parent cannot override service config", () => {
  it("takes DATABASE_URL from core-backend, not the root .env", () => {
    // Guard the guard: if the fixtures change, the test must not pass vacuously.
    expect(PARENT_VALUES.DATABASE_URL).toMatch(/^file:/);
    expect(SERVICE_VALUES.DATABASE_URL).not.toBe(PARENT_VALUES.DATABASE_URL);

    const scratch: NodeJS.ProcessEnv = {};
    loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });

    expect(scratch.DATABASE_URL).toBe(SERVICE_VALUES.DATABASE_URL);
    expect(scratch.DATABASE_URL).not.toBe(PARENT_VALUES.DATABASE_URL);
    expect(scratch.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//i);
  });

  it("never lets the parent's JWT_SECRET or AI_ENGINE_API_KEY through", () => {
    for (const key of ["JWT_SECRET", "AI_ENGINE_API_KEY"] as const) {
      const scratch: NodeJS.ProcessEnv = {};
      loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });
      expect(scratch[key]).toBe(SERVICE_VALUES[key]);
      expect(scratch[key]).not.toBe(PARENT_VALUES[key]);
    }
  });
});

describe("env isolation: real environment wins over files", () => {
  it("does not overwrite an injected value", () => {
    const injected = "postgresql://injected:pw@db.internal:5432/prod";
    const scratch: NodeJS.ProcessEnv = { DATABASE_URL: injected };

    loadEnvFromRoot(SERVICE_DIR, { processEnv: scratch });

    // This is what makes Docker/compose/CI authoritative.
    expect(scratch.DATABASE_URL).toBe(injected);
  });
});

describe("env isolation: cwd independence", () => {
  /**
   * The original defect was invisible from one directory and fatal from
   * another, so the loader must not consult `process.cwd()` at all. Loading the
   * same fixture from two different working directories must produce identical
   * results.
   */
  it("resolves identically after the working directory changes", () => {
    const rootBefore = SERVICE_ROOT;
    const filesBefore = loadEnvFromRoot(SERVICE_DIR, {
      processEnv: {} as NodeJS.ProcessEnv,
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(TMP_ROOT);
      expect(process.cwd()).not.toBe(SERVICE_DIR);

      expect(SERVICE_ROOT).toBe(rootBefore);
      const after = loadEnvFromRoot(SERVICE_DIR, {
        processEnv: {} as NodeJS.ProcessEnv,
      });
      expect(after).toEqual(filesBefore);
      expect(after).not.toContain(PARENT_FILE);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("never resolves an env path against process.cwd()", () => {
    // Structural guard for the exact class of bug: a cwd-relative path is
    // correct from one directory and wrong from every other.
    const source = fs.readFileSync(
      path.join(SERVICE_ROOT, "src", "config", "env.ts"),
      "utf8",
    );
    // Strip the header comment, which legitimately mentions process.cwd().
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.cwd\(\)/);
    expect(code).toMatch(/__dirname/);
  });

  it("candidate file order is highest-priority-first and root-scoped", () => {
    const files = candidateEnvFiles(SERVICE_DIR, "test");
    expect(files.map((f) => path.basename(f.file))).toEqual([
      ".env.local",
      ".env.test",
      ".env",
    ]);
    for (const f of files) {
      expect(path.dirname(f.file)).toBe(SERVICE_DIR);
    }
  });
});

describe("isConfigured", () => {
  it("rejects empty, placeholder, and SQLite-fallback values", () => {
    for (const v of [
      undefined,
      "",
      "   ",
      "change-me",
      "CHANGE_ME_IN_PRODUCTION",
      "your-secret-here",
      "placeholder",
      "example",
      "dummy",
      "xxx",
      "todo",
      "file:./dev.db",
    ]) {
      expect(isConfigured(v), `should reject ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("accepts real values", () => {
    for (const v of [
      "postgresql://user:pw@localhost:5433/db",
      "postgres://localhost/db",
      "redis://localhost:6379/0",
      "rediss://:pw@h:6380/0",
      "https://example.devtunnels.ms",
      "0c1f8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
    ]) {
      expect(isConfigured(v), `should accept ${v.slice(0, 12)}`).toBe(true);
    }
  });
});

describe("describeEnvSources", () => {
  it("names files without revealing values or credentials", () => {
    const s = describeEnvSources();
    expect(s).not.toMatch(/=/);
    expect(s).not.toMatch(/:\/\/[^/\s]*:[^@\s]*@/);
  });
});
