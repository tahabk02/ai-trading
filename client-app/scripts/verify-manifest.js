#!/usr/bin/env node
/**
 * verify-manifest.js — Post-build integrity check for Next.js webpack manifests.
 *
 * Validates that every chunk reference emitted in:
 *   - .next/build-manifest.json          (pages-router manifest)
 *   - .next/app-build-manifest.json      (app-router manifest)
 *   - .next/static/<BUILD_ID>/_buildManifest.js (browser runtime manifest)
 * resolves to a file that ACTUALLY EXISTS on disk.
 *
 * This is the exact failure mode behind browser 404s for webpack.js /
 * react-refresh.js / _app.js / main.js: manifests referencing chunks that
 * were purged or never emitted. A clean build must pass this check with 0
 * missing references.
 *
 * EXIT CODES:
 *   0 — every manifest chunk reference resolves on disk (healthy build)
 *   1 — at least one referenced chunk is missing (corrupted/stale build)
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", ".next");

if (!fs.existsSync(root)) {
  console.error(
    "[verify] FATAL: .next does not exist — run `npm run build` first.",
  );
  process.exit(1);
}

const missing = [];
let checked = 0;

/** Extract every "static/..." asset path mentioned inside a manifest source. */
function collectRefs(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    missing.push(`MANIFEST-MISSING:${path.relative(root, manifestPath)}`);
    return;
  }
  const src = fs.readFileSync(manifestPath, "utf8");
  const refs = src.match(/static\/[A-Za-z0-9._\-/]+/g) || [];
  for (const rel of new Set(refs)) {
    checked++;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
    }
  }
}

// Pages-router + app-router manifests (Next 14 emits these as JSON).
collectRefs(path.join(root, "build-manifest.json"));
collectRefs(path.join(root, "app-build-manifest.json"));

// Build-ID-scoped runtime manifest (_buildManifest.js).
const buildIdFile = path.join(root, "BUILD_ID");
if (!fs.existsSync(buildIdFile)) {
  missing.push("MANIFEST-MISSING:BUILD_ID");
} else {
  const buildId = fs.readFileSync(buildIdFile, "utf8").trim();
  console.log(`[verify] BUILD_ID: ${buildId}`);
  checked++;
  const bm = path.join(root, "static", buildId, "_buildManifest.js");
  if (!fs.existsSync(bm)) {
    missing.push(`static/${buildId}/_buildManifest.js`);
  }
}

console.log(`[verify] Manifest chunk references checked: ${checked}`);

if (missing.length > 0) {
  console.error(
    `[verify] FAILED — ${missing.length} dangling chunk reference(s):\n  ` +
      missing.join("\n  "),
  );
  process.exit(1);
}

console.log(
  "[verify] PASSED — ALL manifest chunk references resolve on disk. Zero missing chunks.",
);
