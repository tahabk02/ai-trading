import { Router } from "express";
import { getExecutionLogs } from "../controllers/audit.controller";

const router = Router();

// ── PART 44 [456] Signal & trade execution audit trail ──
router.get("/audit/execution-logs", getExecutionLogs);

export default router;
