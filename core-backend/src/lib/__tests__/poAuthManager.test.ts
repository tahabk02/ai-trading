import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * poAuthManager shells out to the Python refresher (no Node browser). These
 * tests mock `child_process` + `fs` so the whole orchestration, parsing and
 * health-snapshot surface is verified WITHOUT a browser, network or SSID.
 */

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

const existsMock = vi.hoisted(() => vi.fn());
vi.mock("fs", () => ({
  existsSync: existsMock,
  readFileSync: vi.fn(() => "{}"),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

const secretsMock = vi.hoisted(() => {
  const value: Record<string, unknown> = {
    POCKET_BRIDGE_PYTHON: "",
    POCKET_BRIDGE_HOST: "127.0.0.1",
    POCKET_BRIDGE_PORT: 8788,
    PO_EMAIL: "",
    PO_PASSWORD: "",
    PO_EMAIL_LOGIN: "false",
    PO_LOGIN_TIMEOUT: 45,
    PO_AUTH_NODE_TRIGGER: "false",
  };
  return { value };
});
vi.mock("../../config/secrets", () => ({
  secrets: secretsMock.value,
  default: secretsMock.value,
}));

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  PoAuthManager,
  maskSecret,
} from "../../services/poAuthManager";

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

/** Resolve spawn with a given stdout/stderr and exit code. */
function mockSpawnOnce(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): void {
  spawnMock.mockImplementation(() => {
    const proc = fakeProc();
    process.nextTick(() => {
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("close", opts.code ?? 0);
    });
    return proc;
  });
}

const manager = PoAuthManager.getInstance();

beforeEach(() => {
  spawnMock.mockReset();
  existsMock.mockReset();
  existsMock.mockImplementation(
    (p: string) =>
      String(p).endsWith("refresh_ssid.py") ||
      String(p).endsWith("po_session.json"),
  );
  secretsMock.value.PO_EMAIL = "";
  secretsMock.value.PO_PASSWORD = "";
  secretsMock.value.PO_EMAIL_LOGIN = "false";
  secretsMock.value.PO_AUTH_NODE_TRIGGER = "false";
  secretsMock.value.POCKET_BRIDGE_PYTHON = "";
});

describe("credential fallback posture", () => {
  it("is unavailable by default (opt-in required)", () => {
    expect(manager.isCredentialFallbackAvailable()).toBe(false);
  });

  it("is unavailable when the flag is on but a half is missing", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "true";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "";
    expect(manager.isCredentialFallbackAvailable()).toBe(false);
  });

  it("is available when enabled AND fully configured", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "1";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    expect(manager.isCredentialFallbackAvailable()).toBe(true);
  });

  it("snapshot masks the email and never leaks the password", () => {
    secretsMock.value.PO_EMAIL_LOGIN = "true";
    secretsMock.value.PO_EMAIL = "trader@example.com";
    secretsMock.value.PO_PASSWORD = "s3cret";
    const snap = manager.buildSnapshot();
    expect(snap.credentialFallback.available).toBe(true);
    expect(snap.credentialFallback.emailMasked).toBe("tra***");
    expect(JSON.stringify(snap)).not.toContain("s3cret");
    expect(JSON.stringify(snap)).not.toContain("trader@example.com");
  });
});

describe("refresh orchestration", () => {
  it("parses REFRESH_METHOD=credential_login from the refresher output", async () => {
    mockSpawnOnce({
      stdout:
        "captured ssid=abc*** after 2.0s\n" +
        "REFRESH_METHOD=credential_login\n" +
        "SUCCESS: updated po_session.json and .env\n",
      code: 0,
    });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(true);
    expect(result.method).toBe("credential_login");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The spawned command is the python interpreter running refresh_ssid.py.
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(String(cmd).length).toBeGreaterThan(0);
    expect(String(args[0])).toMatch(/refresh_ssid\.py$/);
  });

  it("defaults to the session tier on a clean exit with no method token", async () => {
    mockSpawnOnce({ stdout: "captured ssid=abc*** after 1.0s\n", code: 0 });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(true);
    expect(result.method).toBe("session");
  });

  it("reports SESSION_EXPIRED as a failed refresh", async () => {
    mockSpawnOnce({
      stderr:
        "FAILURE: no auth frame captured\n" +
        "SESSION_EXPIRED — re-run capture_session.py\n",
      code: 1,
    });
    const result = await manager.refresh("test");
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
    expect(result.error).toContain("SESSION_EXPIRED");
  });

  it("degrades cleanly when the refresher script is missing", async () => {
    existsMock.mockReturnValue(false);
    const result = await manager.refresh("test");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("records the last outcome on the snapshot", async () => {
    mockSpawnOnce({
      stdout: "REFRESH_METHOD=session\nSUCCESS: updated\n",
      code: 0,
    });
    await manager.refresh("startup");
    const snap = manager.buildSnapshot();
    expect(snap.refresh.lastOk).toBe(true);
    expect(snap.refresh.lastMethod).toBe("session");
    expect(snap.refresh.lastReason).toBe("startup");
    expect(snap.refresh.lastAt).not.toBeNull();
  });
});

describe("auth-failure auto trigger", () => {
  it("is a no-op unless PO_AUTH_NODE_TRIGGER is enabled", async () => {
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "false";
    await manager.maybeAutoRefresh("relay_session_expired");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("triggers a refresh when explicitly enabled", async () => {
    secretsMock.value.PO_AUTH_NODE_TRIGGER = "true";
    mockSpawnOnce({ stdout: "REFRESH_METHOD=session\n", code: 0 });
    await manager.maybeAutoRefresh("relay_session_expired", { force: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("maskSecret", () => {
  it("keeps only the leading characters", () => {
    expect(maskSecret("trader@example.com", 3)).toBe("tra***");
    expect(maskSecret("", 3)).toBe("");
  });
});
