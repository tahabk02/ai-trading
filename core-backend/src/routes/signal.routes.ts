import { Router } from "express";
import {
  getSignals,
  getSignalById,
  predictSignal,
  multiPredict,
} from "../controllers/signal.controller";
import { receiveSignal } from "../controllers/receiver.controller";
import { n8nIngress } from "../controllers/n8nIngress.controller";
import { getOrderBook } from "../controllers/orderbook.controller";
import { getSymbols } from "../controllers/symbol.controller";
import { getQuotes } from "../controllers/quotes.controller";
import { requireAiEngineKey } from "../middlewares/internalAuth.middleware";

const router = Router();

router.get("/signals", getSignals);
router.get("/signals/:id", getSignalById);
// Internal endpoint for AI Engine fallback — gated by the service-to-service
// shared secret (X-API-Key == AI_ENGINE_API_KEY) [PART 44.1 [503]].
router.post("/signals/receive", requireAiEngineKey, receiveSignal);
// PHASE 5 — ZERO-WAIT n8n ingress: an external workflow POSTs a finalized
// CALL/PUT (or WAITING) verdict and it is fanned out over `live_quant_signal`
// (+ `new_signal` for SIGNAL_GENERATED) at receipt, with no persistence hop.
// Gated by the same service-to-service secret as /signals/receive.
router.post("/signals/n8n-ingress", requireAiEngineKey, n8nIngress);
router.post("/predict", predictSignal); // Proxy to Python AI Engine /api/v1/predict
router.post("/multi-predict", multiPredict); // Market-terminal batch prediction
router.get("/orderbook", getOrderBook); // Real order book from Binance/Alpaca
router.get("/symbols", getSymbols); // Symbol registry for autocomplete
router.get("/quotes", getQuotes); // All-pairs live quotes snapshot (market terminal)

export default router;
