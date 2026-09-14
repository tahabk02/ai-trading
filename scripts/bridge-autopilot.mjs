#!/usr/bin/env node
/**
 * bridge-autopilot.mjs — Pocket Option bridge autopilot (Node.js, zero deps).
 *
 * Automates the whole "SSID lifecycle" for the live bridge feed:
 *
 *   1. `set`  — inject a fresh Pocket Option session token `42["auth",{...}]`
 *               into pocket-bridge/.env AND core-backend/.env (atomic, keeps
 *               every other line intact). A RAW token (e.g. `pscjrevo…`) is
 *               auto-wrapped into the full payload the broker expects.
 *   2. `start` — same injection (optional), then spawns `npm run dev` and
 *               waits until the WebSocket relay proves it is ACTUALLY
 *               streaming live ticks (not just "connected").
 *   3. `verify`— one-shot: checks backend HTTP, bridge /health, then opens the
 *               relay WebSocket and counts real tick frames.
 *
 * Truth the verifier guarantees (mirrors the Python bridge states):
 *   - /health status == "connected"  AND
 *   - session_expired == false       AND
 *   - >= 1 real `tick` frame received on ws://127.0.0.1:8788
 *
 * A connected bridge with ZERO ticks is reported as a FAILURE (it is exactly
 * the "ticks_received=0" symptom of an expired SSID) — never as healthy.
 *
 * IMPORTANT (honest limit): an SSID can only be produced by a *logged-in
 * browser*, there is no broker API to mint one. This script CANNOT re-login.
 * It injects a token you already have, launches the stack, and verifies the
 * feed — and when the token is dead it tells you loudly to re-run the
 * (existing, Playwright-based) `pocket-bridge/session/capture_session.py`,
 * which the bridge also auto-refreshes from (every 30 min + after auth fail).
 *
 * Usage:
 *   node scripts/bridge-autopilot.mjs set --ssid "pscjrevo…"
 *   node scripts/bridge-autopilot.mjs start --ssid "pscjrevo…"
 *   node scripts/bridge-autopilot.mjs start
 *   node scripts/bridge-autopilot.mjs verify
 *
 * Options: --ssid <token|payload>  --min-ticks <n>  --timeout <ms>
 *          --max-wait <s>  --interval <s>  --once  --verbose
 *
 * Requires Node >= 22 (global fetch + WebSocket). No npm install needed.
 */

import { execFile, execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.autopilot.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

// Test hook: point the setter at a scratch tree (BRIDGE_AUTOPILOT_ENV_DIR).
const ENV_ROOT = process.env.BRIDGE_AUTOPILOT_ENV_DIR
  ? resolve(String(process.env.BRIDGE_AUTOPILOT_ENV_DIR))
  : ROOT;

const SSID_KEY = "POCKET_OPTION_SSID";
const UID_KEY = "POCKET_OPTION_UID";
const DEMO_KEY = "POCKET_OPTION_IS_DEMO";

// .env files that feed the SSID to the running services (only write the root
// one when it already declares the key, so we never surprise unrelated config).
const ENV_FILES = [
  resolve(ENV_ROOT, "pocket-bridge", ".env"),
  resolve(ENV_ROOT, "core-backend", ".env"),
  resolve(ENV_ROOT, ".env"),
];

const HEALTH_URL = "http://127.0.0.1:8789/health";
const RELAY_URL = "ws://127.0.0.1:8788";
// MASTER MISSION 1.1 — the backend 404 root cause was fetching the bare
// server root (GET /); Express serves no route there. Probe the root health
// endpoint instead: GET /health → {status:"ok", uptime, version}.
const BACKEND_URL = "http://127.0.0.1:4000/health";

// MASTER MISSION 3.5/4.x — when the bridge reports an expired session, kick
// the (existing, Playwright-based) SSID refresher instead of only printing a
// hint. It reads the current po_session.json into a fresh raw token, so it
// needs no browser login if the session file is still alive.
const PY_EXE =
  process.platform === "win32"
    ? resolve(ROOT, ".venv-1", "Scripts", "python.exe")
    : resolve(ROOT, ".venv-1", "bin", "python");
const REFRESH_SSID = resolve(
  ROOT,
  "pocket-bridge",
  "session",
  "refresh_ssid.py",
);

// ── small helpers ────────────────────────────────────────────────────────────

function mask(value, head = 8) {
  const v = String(value ?? "");
  return v.length <= head ? v : `${v.slice(0, head)}…`;
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function getValue(lines, key) {
  for (const line of lines) {
    const m = line.match(/^[ \t]*([\w.-]+)[ \t]*=[ \t]*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if (v.length >= 2) {
      const q0 = v[0];
      if ((q0 === '"' || q0 === "'") && v.endsWith(q0)) v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

function upsertEnv(lines, key, value) {
  const out = [];
  let replaced = false;
  for (const line of lines) {
    if (/^[ \t]*#/.test(line)) {
      out.push(line);
      continue;
    }
    const m = line.match(/^[ \t]*([\w.-]+)[ \t]*=/);
    if (m && m[1] === key) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${key}=${value}`);
  return out;
}

/** Normalize a raw token or a full `42["auth",{...}]` payload. */
function normalizeSsid(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("empty SSID");
  if (raw.startsWith("42[")) {
    let arr;
    try {
      arr = JSON.parse(raw.slice(2));
    } catch (err) {
      throw new Error(`invalid 42[...] payload: ${err.message}`);
    }
    if (
      !Array.isArray(arr) || arr[0] !== "auth" || !arr[1] ||
      typeof arr[1] !== "object" || !arr[1].session
    ) {
      throw new Error('SSID must be a raw session token or a 42["auth",{...}] payload');
    }
    return { payload: raw, session: String(arr[1].session) };
  }
  return { payload: null, session: raw };
}

function buildPayload(session, uid, isDemo) {
  const numeric = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const auth = {
    session,
    isDemo: numeric(isDemo, 1),
    uid: numeric(uid, 0),
    platform: 2,
    isFastHistory: true,
  };
  return "42" + JSON.stringify(["auth", auth]);
}

function writeSsid(rawInput) {
  const { payload, session } = normalizeSsid(rawInput);
  const written = [];
  for (const path of ENV_FILES) {
    const isRootEnv = path === ENV_FILES[2];
    const exists = existsSync(path);
    if (isRootEnv && !exists) continue;
    if (isRootEnv && getValue(readLines(path), SSID_KEY) === undefined) continue;
    const lines = readLines(path);
    const uid = getValue(lines, UID_KEY) ?? "0";
    const isDemo = getValue(lines, DEMO_KEY) ?? "1";
    const finalPayload = payload ?? buildPayload(session, uid, isDemo);
    const next = upsertEnv(lines, SSID_KEY, finalPayload);
    atomicWrite(path, next.join("\n").replace(/\n+$/, "\n"));
    written.push(path);
  }
  if (written.length === 0) {
    const path = ENV_FILES[0];
    const finalPayload = payload ?? buildPayload(session, "0", "1");
    atomicWrite(path, finalPayload + "\n");
    written.push(path);
  }
  return { session, written };
}

// ── WebSocket (Node>=22 global, fallback to core-backend's `ws`) ────────────

function makeWebSocket(url) {
  if (typeof WebSocket !== "undefined") return new WebSocket(url);
  const require_ = createRequire(resolve(ROOT, "core-backend", "package.json"));
  const WS = require_("ws");
  return new WS(url);
}

// ── verification ─────────────────────────────────────────────────────────────

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message || String(err) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Open the relay websocket and watch for live frames.
 * Resolves with a verdict report; never rejects (network errors become FAILURE).
 */
function verifyRelay({ timeoutMs = 15_000, minTicks = 1 } = {}) {
  return new Promise((resolveOut) => {
    let ws;
    try {
      ws = makeWebSocket(RELAY_URL);
    } catch (err) {
      return resolveOut(finishReport({ fatal: err.message }));
    }
    const report = {
      opened: false,
      closed: false,
      error: null,
      hello: false,
      ready: false,
      status: null,
      ticks: 0,
      candles: 0,
      snapshots: 0,
      lastPrice: null,
      lastSymbol: null,
    };
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* best-effort */
      }
      resolveOut(finishReport(report));
    };

    const timer = setTimeout(finish, timeoutMs);

    const onFrame = (data) => {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      switch (frame.type) {
        case "hello":
          report.hello = true;
          break;
        case "ready":
          report.ready = true;
          break;
        case "status":
          if (frame.payload?.status) report.status = frame.payload.status;
          break;
        case "tick":
          report.ticks += 1;
          report.lastPrice = frame.payload?.price ?? report.lastPrice;
          report.lastSymbol = frame.payload?.symbol ?? report.lastSymbol;
          break;
        case "candle":
          report.candles += 1;
          break;
        case "snapshot":
          report.snapshots += 1;
          break;
        default:
          break;
      }
      if (report.hello && report.status != null && report.ticks >= minTicks) {
        finish();
      }
    };

    ws.addEventListener("message", (ev) => onFrame(ev.data));
    ws.addEventListener("open", () => {
      report.opened = true;
    });
    ws.addEventListener("error", (ev) => {
      report.error = ev.message || "WebSocket error";
      if (!report.opened) finish();
    });
    ws.addEventListener("close", () => {
      report.closed = true;
      finish();
    });
  });
}

function finishReport(report) {
  const verdict = { ok: false, label: "FAILURE", reason: "", report };
  if (report.fatal) {
    verdict.reason = `relay unreachable: ${report.fatal}`;
    return verdict;
  }
  if (!report.opened) {
    verdict.reason = report.error
      ? `relay connection failed (${report.error}) — is the bridge running?`
      : "relay connection could not be opened";
    return verdict;
  }
  if (report.closed && report.ticks === 0) {
    verdict.reason = "relay WebSocket closed before any live data was seen";
    return verdict;
  }
  if (report.ticks > 0) {
    verdict.ok = true;
    verdict.label = "STREAMING";
    verdict.reason =
      `live ticks flowing — ticks=${report.ticks} candles=${report.candles} ` +
      `status=${report.status ?? "?"} last=${report.lastPrice} ${report.lastSymbol ?? ""}`;
    return verdict;
  }
  if (report.status != null && report.status !== "connected") {
    verdict.reason = `bridge status=${report.status} — NOT connected (${report.status})`;
    return verdict;
  }
  verdict.reason =
    "bridge says connected but ZERO ticks this window — " +
    "this is the classic expired-SSID symptom (ticks_received=0). " +
    "Re-run: python pocket-bridge/session/capture_session.py";
  return verdict;
}

// Last bridge /health payload seen (used by the monitor loop to detect
// repeated auth failures → CRITICAL stop).
let lastHealth = null;

async function showHealth({ verbose = false } = {}) {
  const h = await fetchJson(HEALTH_URL);
  if (h.error) {
    lastHealth = null;
    console.log(`[health] unreachable FATAL ${HEALTH_URL} (${h.error})`);
    return null;
  }
  lastHealth = h;
  console.log(
    `[health] status=${h.status} session_expired=${h.session_expired} ` +
      `session_file=${h.session_file} age_days=${h.session_age_days} ` +
      `cookies=${h.cookies}`,
  );
  if (verbose) {
    console.log(
      `[health] ssid_present=${h.ssid_present} ssid_format=${h.ssid_format} ` +
        `last_tick_ts=${h.last_tick_ts} ticks_received=${h.ticks_received} ` +
        `candles_emitted=${h.candles_emitted} symbols=${JSON.stringify(h.symbols)}`,
    );
  }
  return h;
}

async function showBackend({ verbose = false } = {}) {
  const res = await fetchJson(BACKEND_URL, 3000);
  if (res.error) {
    console.log(`[backend] ${BACKEND_URL} FAILED (${res.error})`);
    return false;
  }
  console.log(
    `[backend] ${BACKEND_URL} OK status=${res.status} version=${res.version ?? "?"} ` +
      `uptime=${res.uptime ?? "?"}s`,
  );
  if (verbose) console.log("[backend]", JSON.stringify(res));
  return true;
}

// MASTER MISSION 4.x — auto-refresh the SSID from the persisted browser
// session (refresh_ssid.py: po_session.json → fresh raw token → .env).
function runRefreshSsid({ verbose = false } = {}) {
  return new Promise((resolve) => {
    let cp;
    try {
      cp = execFile(
        PY_EXE,
        [REFRESH_SSID],
        { timeout: 120_000, windowsHide: true },
        (err, stdout, stderr) => {
          const out = String(stdout || "").trim();
          const errText = String(stderr || "").trim();
          if (verbose) {
            console.log(`[refresh] python ${REFRESH_SSID}`);
            if (out) console.log(`[refresh] stdout: ${out}`);
            if (errText) console.log(`[refresh] stderr: ${errText}`);
          }
          // refresh_ssid.py prints the actionable line on stdout; treat
          // "SESSION_EXPIRED" in the output as the failure signal.
          const failed =
            !!err && /SESSION_EXPIRED|Traceback|Error/i.test(`${out}\n${errText}`);
          resolve({ ok: !err && !failed, out, err: errText });
        },
      );
    } catch (err) {
      resolve({ ok: false, out: "", err: String(err.message) });
    }
    if (cp) {
      cp.on("error", (spawnErr) => {
        // execFile also reports spawn errors via the callback; ignore dupes.
        if (cp.stdout === undefined) resolve({ ok: false, out: "", err: spawnErr.message });
      });
    }
  });
}

async function runVerify({ timeoutMs, minTicks, verbose = false }) {
  console.log("── verifying live feed ──────────────────────────────");
  const backendOk = await showBackend({ verbose });
  if (!backendOk && verbose) {
    console.log(
      "[backend] NOTE: backend :4000 down does not by itself prove the feed " +
        "is dead — continuing to the bridge checks.",
    );
  }
  const health = await showHealth({ verbose });
  if (health && health.session_expired === true) {
    console.log(
      "[FAIL] SESSION_EXPIRED — auto-triggering refresh_ssid.py (existing session file, no browser needed)…",
    );
    const refreshed = await runRefreshSsid({ verbose });
    if (refreshed.ok) {
      console.log(
        "[refresh] [OK] refresh_ssid.py wrote a fresh token — the bridge will " +
          "pick it up on its next auth cycle; re-verifying …",
      );
      const health2 = await showHealth({ verbose });
      if (health2 && health2.session_expired === false) {
        console.log("[OK] SSID refreshed — session is live again");
      } else {
        console.log(
          "[CRITICAL] SSID still expired right after refresh — the persisted " +
            "session itself is dead. Re-run: python pocket-bridge/session/capture_session.py",
        );
        return false;
      }
    } else {
      console.log(
        `[CRITICAL] refresh_ssid.py failed (${refreshed.err || refreshed.out || "no output"}) — ` +
          "re-run: python pocket-bridge/session/capture_session.py",
      );
      return false;
    }
  }
  const report = await verifyRelay({ timeoutMs, minTicks });
  const mark = report.ok ? "[OK]" : "[FAIL]";
  console.log(`${mark} ${report.label}: ${report.reason}`);
  if (!report.ok) {
    console.log(
      "[hint] POCKET_OPTION_SSID is read ONLY at process start. If you just " +
        "updated the .env, the running processes still hold the OLD token — " +
        "stop them and re-run: node scripts/bridge-autopilot.mjs start",
    );
  }
  return report.ok;
}

// ── run the dev stack ────────────────────────────────────────────────────────

let devChild = null;

function stopDevTree() {
  if (!devChild || !devChild.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${devChild.pid} /t /f`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  } else {
    try {
      process.kill(-devChild.pid, "SIGTERM");
    } catch {
      try {
        devChild.kill();
      } catch {
        /* best-effort */
      }
    }
  }
}

["SIGINT", "SIGTERM"].forEach((sig) =>
  process.on(sig, () => {
    console.log(`\n[autopilot] ${sig} received — stopping dev stack …`);
    stopDevTree();
    process.exit(130);
  }),
);

function startDev() {
  devChild = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  devChild.on("error", (err) => {
    console.error("[autopilot] failed to spawn npm run dev:", err.message);
    process.exit(1);
  });
  devChild.on("exit", (code) => {
    console.log(`[autopilot] npm run dev exited (code=${code})`);
    process.exit(typeof code === "number" && code !== 0 ? 2 : 0);
  });
  return devChild;
}

function parseArgs() {
  const args = process.argv.slice(2);
  // First NON-flag token is the subcommand (set | verify | start). Flags may
  // appear before it (so `node scripts/bridge-autopilot.mjs --once --verbose`
  // resolves to start).
  let cmd = "start";
  for (const a0 of args) {
    if (a0.startsWith("--")) continue;
    cmd = a0;
    break;
  }
  const opts = {
    minTicks: 1,
    timeoutMs: 15_000,
    maxWaitSec: 180,
    intervalSec: 60,
    ssid: "",
    once: false,
    verbose: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const next = () => args[i + 1];
    if (a === "--ssid") {
      opts.ssid = next();
      i += 1;
    } else if (a === "--min-ticks") {
      opts.minTicks = Number(next());
      i += 1;
    } else if (a === "--timeout") {
      opts.timeoutMs = Number(next());
      i += 1;
    } else if (a === "--max-wait") {
      opts.maxWaitSec = Number(next());
      i += 1;
    } else if (a === "--interval") {
      opts.intervalSec = Number(next());
      i += 1;
    } else if (a === "--once") {
      opts.once = true;
    } else if (a === "--verbose") {
      opts.verbose = true;
    } else if (a === "set" || a === "verify" || a === "start") {
      // subcommand token — nothing more to parse from it
    } else {
      console.warn(`[autopilot] unknown option: ${a}`);
    }
  }
  return { cmd, opts };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cmd, opts } = parseArgs();

  if (cmd === "set") {
    if (!opts.ssid) {
      console.error("usage: node scripts/bridge-autopilot.mjs set --ssid <token|payload>");
      process.exit(1);
    }
    const { session, written } = writeSsid(opts.ssid);
    for (const p of written) console.log(`[set] updated ${p} (ssid=${mask(session, 6)})`);
    console.log("[set] done — restart the stack with: node scripts/bridge-autopilot.mjs start");
    return;
  }

  if (cmd === "verify") {
    const ok = await runVerify({
      timeoutMs: opts.timeoutMs,
      minTicks: opts.minTicks,
      verbose: opts.verbose,
    });
    process.exit(ok ? 0 : 1);
  }

  // ── start (default) ──
  // Show the token that will actually be used (never the full value).
  const bridgeEnv = resolve(ROOT, "pocket-bridge", ".env");
  const current = getValue(readLines(bridgeEnv), SSID_KEY) || "";
  if (current) {
    const isPayload = current.startsWith("42[");
    console.log(
      `[start] current SSID on disk: ${mask(current, 8)} ` +
        `(${isPayload ? "full payload" : "raw token"}, len=${current.length})`,
    );
  } else {
    console.log("[start] WARNING: no POCKET_OPTION_SSID in pocket-bridge/.env — pass --ssid or capture first");
  }

  if (opts.ssid) {
    try {
      const { session, written } = writeSsid(opts.ssid);
      console.log(`[start] injected ssid=${mask(session, 6)} into ${written.length} .env file(s)`);
    } catch (err) {
      console.error("[start] bad --ssid:", err.message);
      process.exit(1);
    }
  }

  // If a bridge is already answering /health, don't spawn a second stack.
  const existing = await fetchJson(HEALTH_URL, 2000);
  if (existing.error) {
    console.log("[start] no bridge answering yet — launching npm run dev …");
    startDev();
  } else {
    console.log("[start] bridge already running — skipping spawn (verify only)");
  }

  // Wait for the bridge to PROVE it streams real ticks (not just connect).
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const ok = await runVerify({
      timeoutMs: opts.timeoutMs,
      minTicks: opts.minTicks,
      verbose: opts.verbose,
    });
    if (ok) {
      console.log(`[autopilot] PASSED on attempt ${attempt}`);
      // MASTER MISSION 4.x --once: run one verify pass and exit instead of
      // entering the infinite monitor loop. Exit code 0 = feed is live.
      if (opts.once) {
        console.log("[autopilot] --once set — exiting");
        process.exit(0);
      }
      break;
    }
    const waited = Math.round((Date.now() - started) / 1000);
    console.log(`[autopilot] attempt ${attempt} failed after ${waited}s of ${opts.maxWaitSec}s …`);
    if (waited >= opts.maxWaitSec) {
      console.log("[autopilot] FAILED — bridge never streamed. Re-capture the session and/or check logs.");
      process.exit(1);
    }
    await delay(5000);
  }

  // Continuous monitor: log the feed is alive, exit 1 if it dies.
  console.log(`[autopilot] monitoring every ${opts.intervalSec}s (Ctrl+C to stop)`);
  let strikes = 0;
  let authFailStreak = 0;
  for (;;) {
    await delay(opts.intervalSec * 1000);
    const ok = await runVerify({
      timeoutMs: opts.timeoutMs,
      minTicks: opts.minTicks,
      verbose: opts.verbose,
    });
    strikes = ok ? 0 : strikes + 1;
    if (strikes >= 3) {
      console.log("[autopilot] FAILED — 3 consecutive dead checks for the live feed.");
      process.exit(1);
    }
    // MASTER MISSION 4.x — CRITICAL-stop on repeated auth/session failure:
    // don't let the loop hammer the bridge when the session is irrevocably
    // dead (po_session.json exhausted its validity). authFailStreak resets on
    // a healthy pass; after 3 consecutive auth failures → CRITICAL and stop.
    const h = lastHealth;
    const isAuthDead =
      h && (h.session_expired === true || h.status === "auth_failed");
    authFailStreak = isAuthDead ? authFailStreak + 1 : 0;
    if (authFailStreak >= 3) {
      console.log(
        "[autopilot] CRITICAL — 3 consecutive auth failures (SSID/session " +
          "dead). Stopping to avoid ban. Re-capture the session:\n" +
          "  python pocket-bridge/session/capture_session.py",
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("[autopilot] crash:", err);
  process.exit(1);
});