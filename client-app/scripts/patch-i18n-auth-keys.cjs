/**
 * patch-i18n-auth-keys.cjs — one-shot: add signIn/logout keys adjacent to
 * closeNavigation in all four language blocks (en, fr, ar, es).
 * Idempotent: skips insertion if the key already exists.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.resolve(__dirname, "..", "src", "utils", "i18n.ts");
let src = fs.readFileSync(FILE, "utf8");

const INSERTS = [
  { anchor: 'closeNavigation: "Close navigation",', signIn: "Sign in", logout: "Log out" },
  { anchor: 'closeNavigation: "Fermer la navigation",', signIn: "Se connecter", logout: "Se déconnecter" },
  { anchor: 'closeNavigation: "إغلاق التنقل",', signIn: "تسجيل الدخول", logout: "تسجيل الخروج" },
  { anchor: 'closeNavigation: "Cerrar navegación",', signIn: "Iniciar sesión", logout: "Cerrar sesión" },
];

const EOL = src.includes("\r\n") ? "\r\n" : "\n";
let applied = 0;

for (const { anchor, signIn, logout } of INSERTS) {
  const idx = src.indexOf(anchor);
  if (idx === -1) {
    console.error(`  ✗ anchor not found: ${anchor}`);
    continue;
  }
  // Idempotency: skip if signIn already directly follows this anchor.
  const after = src.slice(idx, idx + anchor.length + 200);
  if (after.includes("signIn:")) {
    console.log(`  = already present after: ${anchor}`);
    continue;
  }
  const insertion =
    anchor + EOL + `      signIn: "${signIn}",` + EOL + `      logout: "${logout}",`;
  src = src.replace(anchor, insertion);
  applied++;
}

fs.writeFileSync(FILE, src, "utf8");

// Verify parity across all four blocks.
const count = (re) => (src.match(re) || []).length;
const signInCount = count(/^\s{4}signIn\s*:/gm);
const logoutCount = count(/^\s{4}logout\s*:/gm);
console.log(`inserted: ${applied}/4`);
console.log(`signIn definitions: ${signInCount}`);
console.log(`logout definitions: ${logoutCount}`);
if (applied > 0 && (signInCount !== 4 || logoutCount !== 4)) {
  console.error("✗ parity failure — expected 4 of each");
  process.exit(1);
}
console.log("[patch-i18n-auth-keys] OK");
