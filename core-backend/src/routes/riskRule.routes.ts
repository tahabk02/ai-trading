import { Router } from "express";
import {
  getRiskRules,
  createRiskRule,
  updateRiskRule,
  deleteRiskRule,
} from "../controllers/riskRule.controller";

const router = Router();

// Risk Rules endpoints are accessible without authentication.
// The controllers use a stable default user ID when no JWT is present,
// ensuring local development works out of the box.
router.get("/risk-rules", getRiskRules);
router.post("/risk-rules", createRiskRule);
router.put("/risk-rules/:id", updateRiskRule);
router.delete("/risk-rules/:id", deleteRiskRule);

export default router;
