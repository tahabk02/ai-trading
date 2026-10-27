import { Router } from "express";
import {
  getSignals,
  getSignalById,
  predictSignal,
  multiPredict,
} from "../controllers/signal.controller";
import { receiveSignal } from "../controllers/receiver.controller";
import { getOrderBook } from "../controllers/orderbook.controller";
import { getSymbols } from "../controllers/symbol.controller";
import { getQuotes } from "../controllers/quotes.controller";
import { requireAiEngineKey } from "../middlewares/internalAuth.middleware";
import { requireUserAuth } from "../middlewares/auth.middleware";

const router = Router();

router.get("/signals", requireUserAuth, getSignals);
router.get("/signals/:id", requireUserAuth, getSignalById);
// Internal endpoint for AI Engine fallback — gated by the service-to-service
// shared secret (X-API-Key == AI_ENGINE_API_KEY) [PART 44.1 [503]].
router.post("/signals/receive", requireAiEngineKey, receiveSignal);
router.post("/predict", requireUserAuth, predictSignal); // Proxy to Python AI Engine /api/v1/predict
router.post("/multi-predict", requireUserAuth, multiPredict); // Market-terminal batch prediction
router.get("/orderbook", requireUserAuth, getOrderBook); // Real order book from Binance/Alpaca
router.get("/symbols", requireUserAuth, getSymbols); // Symbol registry for autocomplete
router.get("/quotes", requireUserAuth, getQuotes); // All-pairs live quotes snapshot (market terminal)

export default router;
