import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service";
import { secrets } from "../config/secrets";

/**
 * Normalize the JWT payload onto the request. `auth.service` signs `userId`,
 * while controllers read `req.user.id`; without this mapping every authenticated
 * request still resolved to the anonymous default user.
 */
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication token required" });
  }

  const token = authHeader.split(" ")[1];
  const payload = authService.verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const userId = String(payload.userId ?? payload.id ?? payload.sub ?? "").trim();
  if (!userId) {
    return res.status(401).json({ error: "Invalid token payload" });
  }

  (req as any).user = { ...payload, id: userId };
  next();
};

/**
 * Guard for user/control-plane routes.
 *
 * A supplied Bearer token is always verified. When no token is supplied:
 *   • production (AUTH_REQUIRED=true by default) → 401;
 *   • local development → continue under the legacy single-operator default,
 *     preserving zero-setup use of the dashboard.
 */
export const requireUserAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authMiddleware(req, res, next);
  }
  if (secrets.AUTH_REQUIRED) {
    return res.status(401).json({ error: "Authentication token required" });
  }
  next();
};
