import { Router } from "express";
import {
  getRiskState,
  postTradeResult,
  postResetKillSwitch,
  postEngageKillSwitch,
  putMaxDrawdown,
} from "../controllers/riskState.controller";

const router = Router();

// ── ADVANCED RISK MANAGEMENT & KILL SWITCH API ──
router.get("/risk-state", getRiskState);
router.post("/risk-state/trade-result", postTradeResult);
router.post("/risk-state/reset", postResetKillSwitch);
router.post("/risk-state/engage", postEngageKillSwitch);
router.put("/risk-state/max-drawdown", putMaxDrawdown);

export default router;
