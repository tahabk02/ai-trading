/**
 * PREFLIGHT: reclaim port 4000 from a stale core-backend before boot.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `ts-node-dev --respawn` detaches a WRAPPER from the CHILD that actually
 * holds the listening socket. Killing the wrapper (or clicking "stop" in a
 * runner that only signals the parent) leaves the child alive and owning
 * :4000, so the next boot dies with a bare EADDRINUSE that says nothing about
 * WHICH pid to kill. This script finds the owner by socket, not by name, and
 * only touches processes whose command line actually looks like a core-backend
 * entrypoint — so an unrelated node process is never killed.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/freePort4000.ts          # check only
 *   npx ts-node --transpile-only scripts/freePort4000.ts --kill   # reclaim
 *
 * Exit codes: 0 = port free (or reclaimed), 1 = port busy and --kill not
 * given / kill refused, 2 = no permission to inspect.
 */
import { execSync, spawnSync } from "child_process";
import { createConnection } from "net";

const PORT = Number(process.env.PORT) || 4000;
const KILL = process.argv.includes("--kill");
const HARD = process.argv.includes("--force");

/** Entry-point markers that identify "this is a core-backend process". */
const ENTRYPOINT_MARKERS = ["core-backend", "src/index.ts", "dist/index.js"];

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(false));
    sock.once("timeout", () => done(true));
    sock.once("error", () => done(true));
  });
}

/** PIDs owning a LISTEN socket on the port, straight from the TCP table. */
function listeningPids(port: number): number[] {
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen ` +
        `-ErrorAction SilentlyContinue).OwningProcess`,
    ],
    { encoding: "utf8" },
  );
  if (ps.status !== 0) return [];
  return (ps.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

function cmdline(pid: number): string {
  try {
    return execSync(
      `powershell.exe -NoProfile -Command ` +
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

function ownedByUs(pid: number): boolean {
  const cl = cmdline(pid).toLowerCase();
  if (!cl) return false;
  if (cl.includes("freeport4000")) return false; // never kill ourselves
  return ENTRYPOINT_MARKERS.some((m) => cl.includes(m.toLowerCase()));
}

async function main(): Promise<void> {
  const pid = process.pid;
  if (await isPortFree(PORT)) {
    console.log(`[preflight] port ${PORT} is free`);
    process.exit(0);
  }

  const pids = listeningPids(PORT);
  if (pids.length === 0) {
    // In use but we cannot see the owner (TIME_WAIT, or no permission).
    console.log(
      `[preflight] port ${PORT} is in use but the owning pid is not visible`,
    );
    process.exit(1);
  }

  for (const owner of pids) {
    if (owner === pid) continue;
    const cl = cmdline(owner);
    const ours = ownedByUs(owner);

    console.log(`[preflight] port ${PORT} held by pid ${owner}`);
    console.log(`[preflight]   cmdline: ${cl || "(unavailable)"}`);

    if (!ours) {
      console.log(
        `[preflight]   NOT a core-backend entrypoint — refusing to kill it.`,
      );
      console.log(
        `[preflight]   Stop that process manually and re-run.`,
      );
      process.exit(1);
    }

    if (!KILL) {
      console.log(
        `[preflight]   stale core-backend. Re-run with --kill to reclaim.`,
      );
      process.exit(1);
    }

    // ts-node-dev spawns a child under a wrapper: killing the socket owner is
    // what actually frees the port, so target THIS pid rather than a parent.
    console.log(`[preflight]   terminating stale core-backend (${HARD ? "force" : "graceful"})`);
    spawnSync("taskkill", ["/PID", String(owner), ...(HARD ? ["/F"] : [])], {
      stdio: "ignore",
    });

    // Give the kernel a moment to release the socket.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isPortFree(PORT)) {
        console.log(`[preflight] port ${PORT} reclaimed`);
        process.exit(0);
      }
    }

    // Escalate once: a detached child may ignore the polite request.
    spawnSync("taskkill", ["/PID", String(owner), "/F"], { stdio: "ignore" });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await isPortFree(PORT)) {
        console.log(`[preflight] port ${PORT} reclaimed (force)`);
        process.exit(0);
      }
    }
  }

  console.log(`[preflight] FAILED to free port ${PORT}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[preflight] error:", (err as Error).message);
  process.exit(2);
});