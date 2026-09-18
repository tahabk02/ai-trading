// ── Build-Time Client Env (client-safe) ──
// Browser code must NEVER reference the `process` global at runtime. Next.js
// statically inlines `process.env.NEXT_PUBLIC_*` when it appears as a STATIC
// string literal (never `process.env[key]`, never optional-chained). Importing
// these constants is the only client-safe way to reach the env values — each
// export inlines to its literal value in the browser bundle.
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "";
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "";
export const AI_ENGINE_URL = process.env.NEXT_PUBLIC_AI_ENGINE_URL ?? "";