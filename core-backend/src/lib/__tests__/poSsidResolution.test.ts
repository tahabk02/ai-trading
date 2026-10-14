import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolvePoSsid,
  readSsidFromEnvFile,
  readSsidFromSessionFile,
  applySsidToEnv,
  unwrapQuotes,
} from "../../config/poSsid";

/**
 * PART 50 [HEADLESS-PO-FEED] — the CENTRAL SSID resolver. These pin the
 * precedence (env → pocket-bridge/.env → po_session.json) and, critically, the
 * SHADOWING FIX: an empty resolution must DELETE the child-env key so the
 * bridge's own python-dotenv can still load `pocket-bridge/.env`.
 *
 * Hermetic: everything runs against a fresh OS-temp fixture tree, so the suite
 * passes from a pristine checkout with no real `pocket-bridge/.env`.
 */

const SSID = '42["auth",{"session":"abc123","isDemo":1,"uid":42}]';

let root: string;
let envPath: string;
let sessionPath: string;

const writeBridgeEnv = (contents: string): void =>
  writeFileSync(envPath, contents, "utf-8");
const writeSession = (data: unknown): void =>
  writeFileSync(sessionPath, JSON.stringify(data), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "po-ssid-"));
  const sessionDir = join(root, "session");
  mkdirSync(sessionDir, { recursive: true });
  envPath = join(root, ".env");
  sessionPath = join(sessionDir, "po_session.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("unwrapQuotes", () => {
  it("strips a single matching wrapping quote pair only", () => {
    expect(unwrapQuotes(`'${SSID}'`)).toBe(SSID);
    expect(unwrapQuotes(`"${SSID}"`)).toBe(SSID);
    expect(unwrapQuotes(SSID)).toBe(SSID);
    expect(unwrapQuotes(`'  ${SSID}  '`)).toBe(SSID);
    expect(unwrapQuotes("")).toBe("");
  });
});

describe("readSsidFromEnvFile", () => {
  it("reads POCKET_OPTION_SSID and unwraps the surrounding single quotes", () => {
    writeBridgeEnv(
      [
        "# a comment = not real",
        "",
        `POCKET_OPTION_UID=138336943`,
        `POCKET_OPTION_SSID='${SSID}'`,
        `OTHER=1`,
      ].join("\n"),
    );
    expect(readSsidFromEnvFile(envPath)).toBe(SSID);
  });

  it("returns '' for a missing file, a missing key, or a commented key", () => {
    expect(readSsidFromEnvFile(join(root, "nope.env"))).toBe("");
    writeBridgeEnv(`# POCKET_OPTION_SSID='${SSID}'\nOTHER=1\n`);
    expect(readSsidFromEnvFile(envPath)).toBe("");
    writeBridgeEnv(`OTHER=1\n`);
    expect(readSsidFromEnvFile(envPath)).toBe("");
  });
});

describe("readSsidFromSessionFile", () => {
  it("extracts the ssid cookie value", () => {
    writeSession({
      cookies: [
        { name: "other", value: "x" },
        { name: "ssid", value: "sess-cookie-9" },
      ],
    });
    expect(readSsidFromSessionFile(sessionPath)).toBe("sess-cookie-9");
  });

  it("returns '' for missing file / no ssid cookie / encrypted payload", () => {
    expect(readSsidFromSessionFile(join(root, "none.json"))).toBe("");
    writeSession({ cookies: [{ name: "other", value: "x" }] });
    expect(readSsidFromSessionFile(sessionPath)).toBe("");
    writeFileSync(sessionPath, "FERNET:gAAAAA-not-json", "utf-8");
    expect(readSsidFromSessionFile(sessionPath)).toBe("");
  });
});

describe("resolvePoSsid precedence", () => {
  it("prefers the real process env above every file", () => {
    writeBridgeEnv(`POCKET_OPTION_SSID='${SSID}'`);
    writeSession({ cookies: [{ name: "ssid", value: "cookie" }] });
    const r = resolvePoSsid({
      envValue: "env-wins",
      bridgeEnvPath: envPath,
      sessionPath,
    });
    expect(r).toEqual({ value: "env-wins", source: "env" });
  });

  it("falls back to pocket-bridge/.env when the env is empty", () => {
    writeBridgeEnv(`POCKET_OPTION_SSID='${SSID}'`);
    writeSession({ cookies: [{ name: "ssid", value: "cookie" }] });
    const r = resolvePoSsid({
      envValue: "  ",
      bridgeEnvPath: envPath,
      sessionPath,
    });
    expect(r).toEqual({ value: SSID, source: "bridge_env" });
  });

  it("falls back to the captured session file when no env file value exists", () => {
    writeBridgeEnv(`OTHER=1\n`);
    writeSession({ cookies: [{ name: "ssid", value: "sess-cookie-9" }] });
    const r = resolvePoSsid({ envValue: "", bridgeEnvPath: envPath, sessionPath });
    expect(r).toEqual({ value: "sess-cookie-9", source: "session_file" });
  });

  it("reports 'none' when no source carries an SSID", () => {
    const r = resolvePoSsid({ envValue: "", bridgeEnvPath: envPath, sessionPath });
    expect(r).toEqual({ value: "", source: "none" });
  });
});

describe("applySsidToEnv (shadowing fix)", () => {
  it("sets the key when an SSID was resolved", () => {
    const env: Record<string, string | undefined> = {};
    applySsidToEnv(env, { value: SSID, source: "bridge_env" });
    expect(env.POCKET_OPTION_SSID).toBe(SSID);
  });

  it("DELETES a pre-existing empty key so python-dotenv can load the .env", () => {
    const env: Record<string, string | undefined> = { POCKET_OPTION_SSID: "" };
    applySsidToEnv(env, { value: "", source: "none" });
    expect("POCKET_OPTION_SSID" in env).toBe(false);
  });

  it("overwrites a stale inherited value with the resolved one", () => {
    const env: Record<string, string | undefined> = {
      POCKET_OPTION_SSID: "stale",
    };
    applySsidToEnv(env, { value: "fresh", source: "bridge_env" });
    expect(env.POCKET_OPTION_SSID).toBe("fresh");
  });
});
