import { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service";
import { logger } from "../utils/logger";

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

  // Attach user to request
  (req as any).user = payload;
  next();
};
