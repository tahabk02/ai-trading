import { Router } from "express";
import authRoutes from "./auth.routes";
import signalRoutes from "./signal.routes";
import userRoutes from "./user.routes";
import healthRoutes from "./health.routes";
import settingsRoutes from "./settings.routes";
import riskRuleRoutes from "./riskRule.routes";
import riskStateRoutes from "./riskState.routes";
import tradesRoutes from "./trades.routes";

const router = Router();

// ── Mount all route groups ──
router.use("/auth", authRoutes);
router.use("/", signalRoutes);
router.use("/users", userRoutes);
router.use("/health", healthRoutes);
router.use("/", settingsRoutes); // GET/PUT /settings
router.use("/", riskRuleRoutes); // CRUD /risk-rules
router.use("/", riskStateRoutes); // GET/POST/PUT /risk-state (kill switch)
router.use("/", tradesRoutes); // POST/GET /trades

export default router;
