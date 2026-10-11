/**
 * poAuthManager.ts — Pocket Option SSID SELF-HEALING ORCHESTRATOR (thin layer)
 *
 * ARCHITECTURE (why this is intentionally small):
 * The actual SSID capture/refresh is a Playwright job that ALREADY lives on the
 * Python side (`pocket-bridge/session/refresh_ssid.py`), reusing the very same
 * interpreter/venv the bridge itself runs in. Duplicating a second browser
 * automation stack in Node would mean a second Chromium download and a second
 * login surface to secure — so this backend module does NOT drive a browser.
 *
 * What it owns:
 *   1. A single, observable SNAPSHOT of the auth posture: is the last-resort
 *      credential fallback opted-in and configured? does a captured session
 *      file exist and how old is it? when did the last refresh run and how?
 *   2. A guarded TRIGGER that shells out to `refresh_ssid.py` in the
 *      pocket-bridge venv, parses `REFRESH_METHOD=...`, and records the
 *      outcome — never throwing into the request path.
 *   3. The credential env the backend forwards to the spawned bridge so a
 *      credential that is set at the backend layer is visible to the Python
 *      refresher too.
 *
 * RECOVERY TIERS (implemented in refresh_ssid.py, summarised here):
 *   - SESSION (preferred): reuse `po_session.json` headlessly. No credentials.
 *   - CREDENTIAL LOGIN (last resort, opt-in PO_EMAIL_LOGIN=1 + PO_EMAIL +
 *     PO_PASSWORD): drive the login form only when the session tier produced no
 *     auth frame. Deliberately never used while a session works (ban safety).
 *
 * The Python bridge ALREADY refreshes on its own schedule (startup / every
 * PO_SESSION_REFRESH_INTERVAL / once after an auth failure). This module is the
 * node-side health + manual/optional-trigger surface; set
 * PO_AUTH_NODE_TRIGGER=true to also let the relay's auth-failure event kick a
 * refresh from here (off by default to avoid a second concurrent login).
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import { logger } from "../utils/logger";
import { secrets } from "../config/secrets";

export type PoAuthRefreshMethod = "session" | "credential_login" | "none";

export interface PoAuthRefreshResult {
  ok: boolean;
  method: PoAuthRefreshMethod;
  durationMs: number;
  reason: string;
  error?: string;
}

export interface PoAuthSnapshot {
  credentialFallback: {
    enabled: boolean;
    configured: boolean;
    available: boolean;
    emailMasked: string | null;
  };
  session: {
    filePresent: boolean;
    ageDays: number | null;
  };
  refreshScript: {
    present: boolean;
    path: string;
    python: string;
  };
  refresh: {
    inFlight: boolean;
    lastAt: string | null;
    lastOk: boolean | null;
    lastMethod: PoAuthRefreshMethod | null;
    lastReason: string | null;
    lastError: string | null;
  };
  nodeTriggerEnabled: boolean;
  timestamp: string;
}

const REFRESH_TIMEOUT_MS = 180_000;
/** Minimum gap between AUTO (auth-failure) triggers — never hammer the broker. */
const MIN_AUTO_REFRESH_INTERVAL_MS = 120_000;
const METHOD_RE = /REFRESH_METHOD=(session|credential_login)\b/;

function asBool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

/** Mask a secret to its first `head` characters — never a full value. */
export function maskSecret(value: string | undefined, head = 3): string {
  const s = String(value || "");
  if (!s) return "";
  return s.length <= head ? `${s[0] || ""}***` : `${s.slice(0, head)}***`;
}

export class PoAuthManager {
  private static instance: PoAuthManager;

  private readonly bridgeDir: string;
  private readonly refreshScriptPath: string;
  private readonly sessionPath: string;
  private readonly pythonPath: string;

  private inFlight = false;
  private lastRefreshAt = 0;
  private lastOk: boolean | null = null;
  private lastMethod: PoAuthRefreshMethod | null = null;
  private lastReason: string | null = null;
  private lastError: string | null = null;

  private constructor() {
    this.bridgeDir = resolve(__dirname, "../../../pocket-bridge");
    this.refreshScriptPath = join(this.bridgeDir, "session", "refresh_ssid.py");
    this.sessionPath = join(this.bridgeDir, "session", "po_session.json");
    this.pythonPath = PoAuthManager.resolvePython(this.bridgeDir);
  }

  public static getInstance(): PoAuthManager {
    if (!PoAuthManager.instance) {
      PoAuthManager.instance = new PoAuthManager();
    }
    return PoAuthManager.instance;
  }

  /**
   * Resolve the project Python interpreter: the explicit override first, then
   * the bridge venv (`.venv-1`), then the bare interpreter names. Reuses the
   * SAME interpreter the bridge auto-spawn uses, so the Playwright install the
   * refresher needs is the one the bridge already depends on.
   */
  private static resolvePython(bridgeDir: string): string {
    if (secrets.POCKET_BRIDGE_PYTHON && secrets.POCKET_BRIDGE_PYTHON.trim()) {
      return secrets.POCKET_BRIDGE_PYTHON.trim();
    }
    const repoRoot = resolve(bridgeDir, "..");
    const candidates = [
      join(repoRoot, ".venv-1", "Scripts", "python.exe"),
      join(repoRoot, ".venv-1", "bin", "python"),
      join(bridgeDir, ".venv", "Scripts", "python.exe"),
      join(bridgeDir, ".venv", "bin", "python"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return process.platform === "win32" ? "python" : "python3";
  }

  /** True when PO_EMAIL + PO_PASSWORD are present AND PO_EMAIL_LOGIN is on. */
  public isCredentialFallbackAvailable(): boolean {
    const configured = Boolean(
      (secrets.PO_EMAIL || "").trim() && (secrets.PO_PASSWORD || "").trim(),
    );
    return configured && asBool(secrets.PO_EMAIL_LOGIN);
  }

  private sessionAgeDays(): number | null {
    if (!existsSync(this.sessionPath)) return null;
    try {
      const metaPath = join(
        this.bridgeDir,
        "session",
        "po_session.meta.json",
      );
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
          captured_at?: string;
        };
        if (meta.captured_at) {
          const ms = Date.parse(meta.captured_at);
          if (Number.isFinite(ms)) {
            return Math.max(0, (Date.now() - ms) / 86_400_000);
          }
        }
      }
      const ageMs = Date.now() - statSync(this.sessionPath).mtimeMs;
      return Math.max(0, ageMs / 86_400_000);
    } catch {
      return null;
    }
  }

  /** Read-only snapshot of the auth posture for /health. Never mutates state. */
  public buildSnapshot(): PoAuthSnapshot {
    const configured = Boolean(
      (secrets.PO_EMAIL || "").trim() && (secrets.PO_PASSWORD || "").trim(),
    );
    const enabled = asBool(secrets.PO_EMAIL_LOGIN);
    return {
      credentialFallback: {
        enabled,
        configured,
        available: enabled && configured,
        emailMasked: maskSecret(secrets.PO_EMAIL, 3) || null,
      },
      session: {
        filePresent: existsSync(this.sessionPath),
        ageDays: this.sessionAgeDays(),
      },
      refreshScript: {
        present: existsSync(this.refreshScriptPath),
        path: this.refreshScriptPath,
        python: this.pythonPath,
      },
      refresh: {
        inFlight: this.inFlight,
        lastAt: this.lastRefreshAt > 0 ? new Date(this.lastRefreshAt).toISOString() : null,
        lastOk: this.lastOk,
        lastMethod: this.lastMethod,
        lastReason: this.lastReason,
        lastError: this.lastError,
      },
      nodeTriggerEnabled: asBool(secrets.PO_AUTH_NODE_TRIGGER),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run `refresh_ssid.py` (session tier, then last-resort credential tier) and
   * record the outcome. Never throws: a spawn failure degrades to
   * `{ ok: false }` so a health probe or an auth-failure hook can never crash
   * the request/ingestion path.
   */
  public async refresh(reason = "manual"): Promise<PoAuthRefreshResult> {
    if (this.inFlight) {
      return {
        ok: false,
        method: "none",
        durationMs: 0,
        reason,
        error: "refresh already in progress",
      };
    }
    if (!existsSync(this.refreshScriptPath)) {
      const error = `refresh_ssid.py not found at ${this.refreshScriptPath}`;
      logger.warn("[PO Auth] %s", error);
      this.recordLast(false, "none", reason, error);
      return { ok: false, method: "none", durationMs: 0, reason, error };
    }

    this.inFlight = true;
    const startedAt = Date.now();
    logger.info("[PO Auth] Refreshing SSID via refresh_ssid.py", {
      reason,
      python: this.pythonPath,
      credentialFallback: this.isCredentialFallbackAvailable(),
    });

    try {
      const { code, stdout, stderr } = await this.runScript();
      const durationMs = Date.now() - startedAt;
      const method = this.parseMethod(stdout, code);
      const ok = code === 0;
      const error = ok
        ? undefined
        : this.summariseFailure(stderr || stdout, code);
      this.recordLast(ok, method, reason, error, durationMs);
      logger[ok ? "info" : "warn"](
        "[PO Auth] Refresh %s method=%s durationMs=%d%s",
        ok ? "succeeded" : "failed",
        method,
        durationMs,
        error ? ` error=${error}` : "",
      );
      return { ok, method, durationMs, reason, error };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof Error ? err.message : String(err);
      this.recordLast(false, "none", reason, error, durationMs);
      logger.error("[PO Auth] Refresh crashed", { reason, error });
      return { ok: false, method: "none", durationMs, reason, error };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Best-effort AUTO trigger for the relay's auth-failure event. Rate-limited so
   * a flap can never spawn a login storm. No-op unless PO_AUTH_NODE_TRIGGER is
   * enabled (the Python bridge already handles auth-failure refresh itself).
   *
   * `opts.force` bypasses the rate limit (still guarded by the enabled flag + the
   * in-flight check) — used by explicit operator triggers.
   */
  public async maybeAutoRefresh(
    reason = "auth_failed",
    opts?: { force?: boolean },
  ): Promise<void> {
    if (!asBool(secrets.PO_AUTH_NODE_TRIGGER)) return;
    if (this.inFlight) return;
    const sinceLast = Date.now() - this.lastRefreshAt;
    if (
      !opts?.force &&
      this.lastRefreshAt > 0 &&
      sinceLast < MIN_AUTO_REFRESH_INTERVAL_MS
    ) {
      logger.debug("[PO Auth] Auto-refresh skipped (rate-limited)", {
        sinceLastMs: sinceLast,
      });
      return;
    }
    await this.refresh(reason);
  }

  /** Env passed to the spawned Python bridge so it inherits the credential
   *  fallback configuration from the backend layer. */
  public bridgeCredentialEnv(): Record<string, string> {
    return {
      PO_EMAIL: secrets.PO_EMAIL || "",
      PO_PASSWORD: secrets.PO_PASSWORD || "",
      PO_EMAIL_LOGIN: secrets.PO_EMAIL_LOGIN || "false",
      PO_LOGIN_TIMEOUT: String(secrets.PO_LOGIN_TIMEOUT || 45),
    };
  }

  /** Extract the method token from the refresher's stdout (defaults to the
   *  session tier on a clean exit, since that is the only tier that runs by
   *  default). */
  private parseMethod(stdout: string, code: number): PoAuthRefreshMethod {
    const match = METHOD_RE.exec(stdout || "");
    if (match) return match[1] as PoAuthRefreshMethod;
    return code === 0 ? "session" : "none";
  }

  /** One concise, secret-free failure line for the snapshot. */
  private summariseFailure(output: string, code: number): string {
    const text = (output || "").trim();
    if (!text) return `refresh_ssid.py exited with code ${code}`;
    const line =
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || "";
    return line || `refresh_ssid.py exited with code ${code}`;
  }

  private recordLast(
    ok: boolean,
    method: PoAuthRefreshMethod,
    reason: string,
    error?: string,
    _durationMs = 0,
  ): void {
    this.lastRefreshAt = Date.now();
    this.lastOk = ok;
    this.lastMethod = method;
    this.lastReason = reason;
    this.lastError = error ?? null;
  }

  private runScript(): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(this.pythonPath, [this.refreshScriptPath], {
          cwd: this.bridgeDir,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* best-effort */
        }
        reject(new Error(`refresh_ssid.py timed out after ${REFRESH_TIMEOUT_MS}ms`));
      }, REFRESH_TIMEOUT_MS);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}

export const poAuthManager = PoAuthManager.getInstance();
