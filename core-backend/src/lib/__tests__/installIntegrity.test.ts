import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const manifest = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };

/**
 * [352] bcrypt installs through `node-pre-gyp install --fallback-to-build`,
 * which can leave no native binding behind while npm still reports success. The
 * backend then crash-loops on boot with MODULE_NOT_FOUND. These tests exist so
 * that the guard which turns that into a loud install-time failure cannot be
 * quietly deleted, and so that a newly added native dependency has to be
 * registered with the guard.
 */
describe("native install integrity", () => {
  const guardPath = path.join(projectRoot, "scripts", "ensure-native.js");

  it("wires the postinstall guard", () => {
    expect(manifest.scripts?.postinstall).toBe("node scripts/ensure-native.js");
    expect(existsSync(guardPath)).toBe(true);
  });

  it("exposes the guard as a standalone verify step", () => {
    expect(manifest.scripts?.["verify:install"]).toBe(
      "node scripts/ensure-native.js",
    );
  });

  it("registers every known native-binding dependency with the guard", () => {
    const guard = readFileSync(guardPath, "utf8");
    const registered = /NATIVE_MODULES\s*=\s*\[([^\]]*)\]/.exec(guard)?.[1] ?? "";
    const listed = registered
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    expect(listed).toContain("bcrypt");
    // bcrypt must stay a real runtime dependency for this guard to matter.
    expect(manifest.dependencies?.bcrypt).toBeDefined();
  });

  it("exits non-zero rather than passing when a native module cannot load", () => {
    const guard = readFileSync(guardPath, "utf8");
    // The silent-pass failure mode is the whole bug: npm ci exited 0 while the
    // service could not boot. The guard must end in an explicit failure exit.
    expect(guard).toMatch(/process\.exit\(failed\s*\?\s*1\s*:\s*0\)/);
    expect(guard).not.toMatch(/process\.exit\(0\)\s*;?\s*$/m);
  });
});