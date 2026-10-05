#!/usr/bin/env node
/**
 * [352] Fail loudly at install time instead of shipping an unbootable service.
 *
 * bcrypt 5.1.1 installs via `node-pre-gyp install --fallback-to-build`, which
 * downloads a prebuilt binary from GitHub releases and, when that download
 * fails, needs a native toolchain to compile. Both paths can fail on a machine
 * that has neither a good connection nor a compiler — and npm still reports a
 * successful install, leaving `lib/binding/napi-v3/bcrypt_lib.node` absent. The
 * backend then crash-loops on boot with
 *
 *   Error: Cannot find module '.../bcrypt/lib/binding/napi-v3/bcrypt_lib.node'
 *
 * even though `npm ci` exited 0. That is the worst shape of install bug: it
 * looks healthy and fails later, on someone else's server.
 *
 * This postinstall step turns that into a deterministic outcome: every native
 * dependency is actually loaded, rebuilt if it does not load, and a genuine
 * failure aborts the install with an actionable message rather than deferring
 * the crash to boot.
 */

const { execFileSync } = require("node:child_process");

/** Packages that load a native binding and therefore must work post-install. */
const NATIVE_MODULES = ["bcrypt"];

function tryLoad(name) {
  try {
    require(name);
    return null;
  } catch (error) {
    return error;
  }
}

function rebuild(name) {
  process.stdout.write(`  rebuilding native module ${name} ...\n`);
  const isWindows = process.platform === "win32";
  execFileSync(isWindows ? "npm.cmd" : "npm", ["rebuild", name], {
    // .cmd shims are not directly spawnable on Windows without a shell.
    shell: isWindows,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

let failed = false;

for (const name of NATIVE_MODULES) {
  const initialError = tryLoad(name);
  if (!initialError) {
    process.stdout.write(`  native module ${name} OK\n`);
    continue;
  }

  process.stdout.write(
    `  native module ${name} failed to load:\n    ${initialError.message.split("\n")[0]}\n`,
  );

  try {
    rebuild(name);
  } catch (rebuildError) {
    process.stderr.write(
      `  could not rebuild ${name}: ${rebuildError.message}\n`,
    );
  }

  const retryError = tryLoad(name);
  if (!retryError) {
    process.stdout.write(`  native module ${name} repaired\n`);
    continue;
  }

  failed = true;
  process.stderr.write(
    [
      "",
      `FATAL: ${name} is installed but not loadable.`,
      "       The backend will crash on boot until this is fixed.",
      "",
      "       Fixes, in order of preference:",
      "         1. allow access to github.com so node-pre-gyp can fetch the",
      "            prebuilt binary (no compiler required)",
      "         2. install build tools (python, and Visual Studio Build Tools",
      "            with the C++ workload) so node-pre-gyp can --fallback-to-build",
      "         3. re-run: npm rebuild " + name,
      "",
      `       Underlying error: ${retryError.message.split("\n")[0]}`,
      "",
    ].join("\n"),
  );
}

process.exit(failed ? 1 : 0);