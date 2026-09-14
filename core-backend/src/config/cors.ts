import type { NextFunction, Request, Response } from "express";

const BASE_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://*.devtunnels.ms",
  "https://*.uks1.devtunnels.ms",
];

function originFromValue(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const configuredOrigins = [
  process.env.CORS_ORIGIN || "",
  process.env.NEXT_PUBLIC_API_URL || "",
]
  .flatMap((value) => value.split(","))
  .map((value) => originFromValue(value.trim()))
  .filter((value): value is string => Boolean(value));

export const allowedOrigins = Array.from(
  new Set([...BASE_ALLOWED_ORIGINS, ...configuredOrigins]),
);

export function isAllowedCorsOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    return (
      /^[^.]+\.devtunnels\.ms$/.test(url.hostname) ||
      /^[^.]+\.uks1\.devtunnels\.ms$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export function corsOriginResolver(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin || isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin ${origin} not allowed by CORS`));
}

export function privateNetworkMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.header("Access-Control-Request-Private-Network") === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
}

export const corsOptions = {
  origin: corsOriginResolver,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Access-Control-Allow-Origin",
    "Access-Control-Request-Private-Network",
  ],
};
