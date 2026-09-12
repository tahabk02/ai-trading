#!/usr/bin/env node
/**
 * audit-i18n.cjs — i18n INTEGRITY AUDITOR
 *
 * 1. Key parity: every language block (en/fr/ar/es) must expose the SAME key set.
 * 2. Usage coverage: every t("key") / translate("xx","key") call site found in
 *    src/** must resolve against the en dictionary (single source of truth).
 *
 * Exit 0 = clean. Exit 1 = missing keys / untranslated call sites.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const I18N_FILE = path.join(ROOT, "src", "utils", "i18n.ts");
const SCAN_DIRS = [
  "src/app",
  "src/components",
  "src/hooks",
  "src/store",
  "src/lib",
  "src/utils",
];
const LANGS = ["en", "fr", "ar", "es"];

const source = fs.readFileSync(I18N_FILE, "utf8");
const lines = source.split(/\r?\n/);

// Strip string-literal CONTENTS so braces inside values ("a {b} c", ${interp})
// can never corrupt brace-depth counting during block boundary detection.
function stripLiterals(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

// ── 1. Extract the key set of every language block ──
const dict = {};
for (const lang of LANGS) {
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s{2}${lang}:\\s*\\{\\s*$`).test(l),
  );
  if (start === -1) {
    console.error(`[audit-i18n] FATAL: language block "${lang}" not found`);
    process.exit(1);
  }
  // Walk braces to find the block's true end.
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const clean = stripLiterals(lines[i]);
    depth += (clean.match(/\{/g) || []).length;
    depth -= (clean.match(/\}/g) || []).length;
    if (depth === 0 && i > start) {
      end = i;
      break;
    }
  }
  const set = new Set();
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^\s{4}([A-Za-z0-9_]+)\s*:/);
    if (m) set.add(m[1]);
  }
  dict[lang] = set;
}

let failures = 0;

// ── Parity report ──
console.log("════════ i18n KEY PARITY ════════");
for (const lang of LANGS) {
  console.log(`  ${lang}: ${dict[lang].size} keys`);
}
const enKeys = dict.en;
for (const lang of LANGS.slice(1)) {
  const missing = [...enKeys].filter((k) => !dict[lang].has(k));
  const extra = [...dict[lang]].filter((k) => !enKeys.has(k));
  if (missing.length) {
    failures += missing.length;
    console.error(
      `  ✗ ${lang} missing ${missing.length} key(s): ${missing.join(", ")}`,
    );
  }
  if (extra.length) {
    failures += extra.length;
    console.error(
      `  ✗ ${lang} has ${extra.length} orphan key(s): ${extra.join(", ")}`,
    );
  }
  if (!missing.length && !extra.length) {
    console.log(`  ✓ ${lang} — full parity with en`);
  }
}

// ── 2. Collect every t("…") / translate("xx","…") call site under src ──
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}
const usageRe = /\bt\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
const translateRe = /\btranslate\(\s*["'][a-z]{2}["']\s*,\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
const used = new Map(); // key -> [file:line]
for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (path.resolve(file) === path.resolve(I18N_FILE)) continue;
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    for (const re of [usageRe, translateRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        const k = m[1];
        if (!used.has(k)) used.set(k, []);
        used.get(k).push(`${rel}:${line}`);
      }
    }
  }
}

console.log("\n════════ CALL-SITE COVERAGE (t / translate) ════════");
console.log(`  distinct keys referenced: ${used.size}`);
const unresolved = [...used.keys()].filter((k) => !enKeys.has(k));
if (unresolved.length) {
  failures += unresolved.length;
  for (const k of unresolved.sort()) {
    console.error(`  ✗ MISSING in dictionary: "${k}"`);
    for (const site of used.get(k)) console.error(`      → ${site}`);
  }
} else {
  console.log("  ✓ every referenced key resolves in the en dictionary");
}

// Unused keys are informational only (kept for future call sites).
const unused = [...enKeys].filter((k) => !used.has(k));
if (unused.length) {
  console.log(
    `  ℹ ${unused.length} dictionary key(s) not yet referenced: ${unused.join(", ")}`,
  );
}

console.log(
  failures === 0
    ? "\n[audit-i18n] PASSED — dictionaries are complete and consistent."
    : `\n[audit-i18n] FAILED — ${failures} problem(s) found.`,
);
process.exit(failures === 0 ? 0 : 1);
