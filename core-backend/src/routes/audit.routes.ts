import { Router } from "express";
import { getExecutionLogs } from "../controllers/audit.controller";
import { requireAdminKey } from "../middlewares/internalAuth.middleware";

const router = Router();

// ── PART 44 [456] / PART 44.1 [503] Signal & trade execution audit trail ──
// Operator surface — gated behind the platform admin key (X-PO-Admin-Key).
router.get("/audit/execution-logs", requireAdminKey, getExecutionLogs);

export default router;
