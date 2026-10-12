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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";

/** Keys this suite mutates — the loader rewrites them via dotenv. */
const TOUCHED = ["DATABASE_URL", "JWT_SECRET", "AI_ENGINE_API_KEY"] as const;

// This file lives at <service>/src/lib/__tests__/ — three levels down.
const SERVICE_ROOT = path.resolve(__dirname, "../../..");
const REPO_ROOT = path.resolve(SERVICE_ROOT, "..");
const PARENT_ENV = path.join(REPO_ROOT, ".env");

/** Read one key from a dotenv file. Returns undefined when absent. */
function readKey(file: string, key: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']?(.*?)["']?\\s*$`);
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(re))
    .find(Boolean)?.[1];
}

/** Fresh, un-run module instance so each test gets its own loader state. */
async function freshEnvModule() {
  vi.resetModules();
  return import("../../config/env");
}

/**
 * The loader mutates `process.env` in place, so every test that calls it must
 * leave the environment exactly as it found it — otherwise a sibling test file
 * observes a half-loaded environment.
 */
const envSnapshot = new Map<string, string | undefined>();
beforeEach(() => {
  for (const k of TOUCHED) envSnapshot.set(k, process.env[k]);
});
afterEach(() => {
  for (const k of TOUCHED) {
    const v = envSnapshot.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("env isolation: service root resolution", () => {
  it("resolves the service root from the module, not the cwd", () => {
    expect(path.basename(SERVICE_ROOT)).toBe("core-backend");
    expect(fs.existsSync(path.join(SERVICE_ROOT, ".env"))).toBe(true);
  });

  it("loads service-local files only, and never the repository-root .env", async () => {
    const { SERVICE_ROOT: root, loadServiceEnv } = await freshEnvModule();

    // The parent file genuinely exists — that is what made the original bug
    // dangerous rather than theoretical.
    expect(fs.existsSync(PARENT_ENV)).toBe(true);

    const loaded = loadServiceEnv();
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded).not.toContain(PARENT_ENV);

    for (const f of loaded) {
      const rel = path.relative(root, f);
      // A leading ".." would mean we read a parent's file.
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("is idempotent", async () => {
    const { loadServiceEnv } = await freshEnvModule();
    const first = loadServiceEnv();
    expect(loadServiceEnv()).toEqual(first);
  });
});

describe("env isolation: the parent cannot override service config", () => {
  it("takes DATABASE_URL from core-backend, not the root .env", async () => {
    const serviceValue = readKey(path.join(SERVICE_ROOT, ".env"), "DATABASE_URL");
    const parentValue = readKey(PARENT_ENV, "DATABASE_URL");

    // Guard the guard: if the fixtures change, the test must not pass vacuously.
    expect(parentValue).toBeTruthy();
    expect(serviceValue).toBeTruthy();
    expect(parentValue).not.toBe(serviceValue);
    expect(parentValue).toMatch(/^file:/);

    vi.resetModules();
    const { loadServiceEnv } = await import("../../config/env");
    for (const k of TOUCHED) delete process.env[k];
    loadServiceEnv();

    expect(process.env.DATABASE_URL).toBe(serviceValue);
    expect(process.env.DATABASE_URL).not.toBe(parentValue);
    expect(process.env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//i);
  });

  it("never lets the parent's JWT_SECRET or AI_ENGINE_API_KEY through", async () => {
    for (const key of ["JWT_SECRET", "AI_ENGINE_API_KEY"]) {
      const parent = readKey(PARENT_ENV, key);
      const service = readKey(path.join(SERVICE_ROOT, ".env"), key);
      if (!parent || !service || parent === service) continue;

      vi.resetModules();
      delete process.env[key];
      const { loadServiceEnv } = await import("../../config/env");
      loadServiceEnv();
      expect(process.env[key]).toBe(service);
      expect(process.env[key]).not.toBe(parent);    }
  });
});

describe("env isolation: real environment wins over files", () => {
  it("does not overwrite an injected value", async () => {
    const injected = "postgresql://injected:pw@db.internal:5432/prod";
    process.env.DATABASE_URL = injected;

    vi.resetModules();
    const { loadServiceEnv } = await import("../../config/env");
    loadServiceEnv();

    // This is what makes Docker/compose/CI authoritative.
    expect(process.env.DATABASE_URL).toBe(injected);
  });
});

describe("env isolation: cwd independence", () => {
  /**
   * The original defect was invisible from one directory and fatal from
   * another, so the loader must not consult `process.cwd()` at all. Moving the
   * process and re-importing proves that directly, in-process, without paying
   * the several-hundred-ms cost of bundling a child entrypoint (which starved
   * the slower tests in this suite of CPU and made them exceed their timeout).
   */
  it("resolves identically after the working directory changes", async () => {
    const before = await freshEnvModule();
    const rootBefore = before.SERVICE_ROOT;
    const filesBefore = before.loadServiceEnv();

    const originalCwd = process.cwd();
    try {
      process.chdir(REPO_ROOT);
      expect(process.cwd()).not.toBe(SERVICE_ROOT);

      vi.resetModules();
      const after = await import("../../config/env");
      expect(after.SERVICE_ROOT).toBe(rootBefore);
      expect(after.loadServiceEnv()).toEqual(filesBefore);
      expect(after.loadedEnvFiles).not.toContain(PARENT_ENV);
      // The value still comes from the service, not the cwd-adjacent root.
      expect(process.env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//i);
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
});

describe("isConfigured", () => {
  it("rejects empty, placeholder, and SQLite-fallback values", async () => {
    const { isConfigured } = await freshEnvModule();
    for (const v of [
      undefined, "", "   ", "change-me", "CHANGE_ME_IN_PRODUCTION",
      "your-secret-here", "placeholder", "example", "dummy", "xxx", "todo",
      "file:./dev.db",
    ]) {
      expect(isConfigured(v), `should reject ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("accepts real values", async () => {
    const { isConfigured } = await freshEnvModule();
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
  it("names files without revealing values or credentials", async () => {
    const { describeEnvSources } = await freshEnvModule();
    const s = describeEnvSources();
    expect(s).not.toMatch(/=/);
    expect(s).not.toMatch(/:\/\/[^/\s]*:[^@\s]*@/);
  });
});
