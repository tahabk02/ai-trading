#!/usr/bin/env node
/**
 * clean-build-cache.js — Manifest & Cache Purge for Next.js builds.
 *
 * WHY THIS EXISTS:
 * Stale artifacts in `.next/` (old build-manifest.js, app-build-manifest.js,
 * hashed chunks from previous builds) and webpack/turbopack caches in
 * `node_modules/.cache/` are the root cause of browser 404s for
 * webpack.js / react-refresh.js / _app.js / main.js: the served HTML or
 * manifest references chunk files that no longer exist on disk after a
 * rebuild. Purging both locations before every compilation guarantees the
 * emitted manifests reference exactly the chunks produced by THIS build.
 *
 * ROBUSTNESS:
 * On Windows, a running `next dev` server or an IDE indexer can hold locks on
 * files inside these directories, causing transient EBUSY / EPERM / ENOTEMPTY
 * errors during deletion. This script retries each purge target several times
 * with a short backoff before failing hard — so CI and local builds don't die
 * on a lock that would have cleared milliseconds later.
 *
 * EXIT CODES:
 *   0 — all targets purged (or never existed)
 *   1 — a target could not be purged after all retries (build must abort,
 *       otherwise next build would emit into a corrupted cache)
 */

const fs = require("fs");
const path = require("path");

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 300;

/** Targets to purge, relative to this project's root (client-app/). */
const PURGE_TARGETS = [".next", path.join("node_modules", ".cache")];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  return (
    err.code === "EBUSY" ||
    err.code === "EPERM" ||
    err.code === "ENOTEMPTY" ||
    err.code === "EACCES"
  );
}

async function rmWithRetry(targetPath, label) {
  // Nothing to do if the target doesn't exist — treat as already clean.
  if (!fs.existsSync(targetPath)) {
    console.log(`[clean] ${label}: not present, nothing to purge`);
    return true;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      console.log(`[clean] ${label}: purged`);
      return true;
    } catch (err) {
      const transient = isTransientError(err);
      console.warn(
        `[clean] ${label}: attempt ${attempt}/${MAX_RETRIES} failed (${err.code || err.message})` +
          (transient ? " — likely a Windows file lock, retrying…" : ""),
      );
      if (!transient || attempt === MAX_RETRIES) {
        console.error(
          `[clean] FATAL: could not purge ${label}. A process may still be holding ` +
            `locks on it (running 'next dev'/'next start', IDE indexer, antivirus). ` +
            `Stop those processes and re-run the build.`,
        );
        return false;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return false;
}

(async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  let allPurged = true;

  console.log(`[clean] Project root: ${projectRoot}`);

  for (const relTarget of PURGE_TARGETS) {
    const absoluteTarget = path.join(projectRoot, relTarget);
    const ok = await rmWithRetry(absoluteTarget, relTarget);
    if (!ok) allPurged = false;
  }

  if (!allPurged) {
    process.exitCode = 1;
    return;
  }

  console.log(
    "[clean] .next and node_modules/.cache build caches purged — " +
      "next build will emit a fresh, self-consistent webpack manifest.",
  );
})();
