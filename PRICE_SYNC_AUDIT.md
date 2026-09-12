# Live Price Synchronization — Deep Code Audit & Fix Report

> **Auditor:** Senior Quantitative Software Architect  
> **Date:** 2025  
> **Status:** ✅ All Critical Issues Resolved

---

## 1. LIVE PRICE DISCREPANCY & BINDING

### Audit Findings

**❌ CRITICAL: `deterministicFallback` fabricated fake prices**

- When ALL services failed, the old code returned `signal: "HOLD"` with `confidence: 0.35`, `target_price: currentPrice * 1.005`, and fake indicator values (`rsi_14: 50.0`, `sma_20: price * 0.98`)
- This could mislead users into thinking the system issued a real HOLD signal when it was actually completely disconnected

**❌ CRITICAL: `currentPrice` fallback chain in dashboard**

- `const displayPrice = currentPrice > 0 ? currentPrice : predictionData?.current_price ?? 0;`
- This allowed rendering `predictionData.current_price` (which could be a stale bar close) even when `currentPrice` was 0 (flushed/no data)

**✅ Positive: Alpaca snapshot is always fetched first**

- `alpacaService.fetchSnapshot()` is called before any other logic
- `livePrice` overrides all bar closes throughout the response

### Fix Applied

**✅ `absoluteTruthFallback` replaces `deterministicFallback`**

- Returns `signal: "NO_DATA"` (never "HOLD")
- Returns `confidence: 0.0` (never a fake 0.35)
- Returns `target_price: null` (no fabricated target)
- Returns `current_price: null` when no live data available
- Returns `current_price: livePrice` when live snapshot exists but ML failed (honest price display)
- All indicators are `null` (no fake RSI/SMA values)
- `warning` field explains exactly why NO_DATA was returned

**✅ Dashboard uses `unifiedPrice = currentPrice` directly**

- No fallback to `predictionData.current_price` — the store's `getPrediction()` atomically updates both
- If `currentPrice` is 0 (flushed/initial), components render "—" or appropriate empty state

**✅ `addLiveSignal` fixed to handle zero prices**

- Changed from `price > 0` to `price != null && typeof price === "number"`
- Zero is a valid price for some assets (though rare)

---

## 2. PREDICTION REFRESH & DYNAMICS

### Audit Findings

**❌ Static target prices from stale model weights**

- `ml_predictor.py` had a `_load_model()` function that loaded `.joblib` files from disk
- If the model was trained on old data, it would produce the same predictions regardless of market shifts
- The `force_retrain` parameter defaulted to `false`

**❌ Dual polling race condition**

- Dashboard `setInterval` called `getPrediction()` every 30s
- `useWebSocket` hook also called `pollOnce()` every 30s, which called `addLiveSignal()`
- Two separate update paths could race, causing price to flip-flop between old and new values

### Fix Applied

**✅ ZERO stale cache — model retrained on EVERY request**

- `ml_predictor.predict_with_rf()` always calls `train_model()` on the latest candles
- `_load_model()` is never called in the production path — only `_save_model()` to persist for debugging
- `force_retrain` parameter is ignored; training is always forced

**✅ Single polling orchestrator**

- `useWebSocket` is the sole polling source
- Dashboard's duplicate `setInterval` removed
- `useWebSocket` calls `getPrediction()` directly (not `addLiveSignal()`)
- `getPrediction()` atomically updates `predictionData`, `currentPrice`, `lastPriceUpdate`, `_priceVersion`

**✅ Dynamic target price computation**

- `target_price = current_price + ATR * 3.0` (BUY)
- `target_price = current_price - ATR * 3.0` (SELL)
- `target_price = current_price ± ATR * 0.2` (HOLD)
- ATR is computed fresh from the latest 14 bars on every request
- `current_price` is always the live Alpaca snapshot, never a bar close

---

## 3. FALLBACK & ERROR TRANSPARENCY

### Audit Findings

**❌ No distinction between ML-powered and fallback predictions**

- The frontend rendered `{signal}` badge identically for ML predictions and Alpaca-computed fallbacks
- Users couldn't tell if the signal was from RandomForest or simple RSI/SMA crossover

**❌ `deterministicFallback` had no `warning` field**

- The old fallback didn't tell the frontend why it was used
- The frontend couldn't display a "DEGRADED" state

### Fix Applied

**✅ Three-tier transparency system:**

| Tier                                | `signal`      | `fallback` | `warning`                                                                                        | `livePriceSource`                  | ML Used?        |
| ----------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------- |
| **Normal** (AI Engine)              | BUY/SELL/HOLD | `false`    | `undefined`                                                                                      | `"alpaca_snapshot"`                | ✅ RandomForest |
| **Degraded** (Alpaca bars)          | BUY/SELL/HOLD | `true`     | `"AI Engine unreachable. Using Alpaca-computed fallback indicators. Signal confidence reduced."` | `"alpaca_snapshot" \| "bar_close"` | ❌ RSI/SMA/ATR  |
| **No Data** (absoluteTruthFallback) | `"NO_DATA"`   | `true`     | `"Alpaca returned 0 bars. AI Engine also unreachable."`                                          | `"none"`                           | ❌ N/A          |

**✅ Frontend renders `warning` when present**

- The `predictionError` state in the Predictive Intelligence widget displays the warning message
- The `fallback` flag can be used to add a yellow "DEGRADED" badge (future enhancement)

---

## 4. COMPLETE DATA FLOW VERIFICATION

### Verified Path: Alpaca → Core Backend → AI Engine → Zustand → Components

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Alpaca Market Data API                                               │
│    GET /v2/stocks/{symbol}/snapshot                                     │
│    GET /v2/stocks/{symbol}/bars?timeframe=1Day&limit=150                │
│                                                                         │
│    Returns: { latestTradePrice: 333.48, bars: [...] }                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Core Backend — signal.controller.predictSignal()                     │
│    Port 4000                                                           │
│                                                                         │
│    a. fetchHistoricalBars(symbol, "1d", 150) → bars[]                 │
│    b. fetchSnapshot(symbol) → { latestTradePrice: 333.48 }             │
│    c. FORWARDS: POST /api/v1/predict                                    │
│       { symbol: "AAPL", candles: bars[], live_price: 333.48 }          │
│    d. RECEIVES: { signal, confidence, target_price, current_price }    │
│    e. OVERRIDES: current_price = 333.48 (livePrice always wins)        │
│    f. ADDS: { currentPrice: 333.48, proxied: true, ... }              │
│    g. RESPONDS: HTTP 200 JSON                                           │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP POST
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. AI Engine — signals.predict_signal() → ml_predictor.predict_with_rf()│
│    Port 8000                                                           │
│                                                                         │
│    a. Validates: live_price is REQUIRED (rejects if missing)           │
│    b. Engineering: computes RSI, SMA, ATR, ADX, MACD, volatility       │
│    c. Training: fits RandomForest(150 estimators) on features          │
│    d. Prediction: predict_proba() → prob_up = 0.72                     │
│    e. Signal: prob_up >= 0.65 && RSI < 75 → "BUY"                     │
│    f. Target: current_price + ATR * 3.0 = 333.48 + 2.50 * 3 = 340.98  │
│    g. Returns: { signal: "BUY", confidence: 0.77, target_price: 340.98,│
│                  current_price: 333.48, ... }                          │
│    h. FALLBACK: if ML fails → signal_generator (ADX/ATR/regime)        │
│       with live_price still used for current_price                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP 200 JSON
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Core Backend — response transformation                              │
│    Port 4000                                                           │
│                                                                         │
│    a. absoluteLivePrice = livePrice (333.48) ?? prediction.current_price│
│    b. Overrides: { current_price: 333.48, currentPrice: 333.48 }       │
│    c. Adds metadata: { proxied, proxyLatencyMs, dataSource, barCount } │
│    d. Returns: HTTP 200 JSON to client                                 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP Response
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. Client — Axios → api.ts → useTradingStore.getPrediction()            │
│    Port 3000                                                           │
│                                                                         │
│    a. apiClient.getPrediction("AAPL") → PredictionResponse             │
│    b. getPrediction calls:                                             │
│       set({                                                             │
│         predictionData: data,           // full prediction object      │
│         currentPrice: data.current_price, // 333.48 (SINGLE TRUTH)     │
│         lastPriceUpdate: data.timestamp,                                │
│         isLoading: false,                                               │
│         _priceVersion: state._priceVersion + 1,   // force re-render   │
│       })                                                               │
│    c. ATOMIC update: all 5 fields change in ONE set() call            │
│       → No intermediate state where components see mismatched values   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ Zustand subscription
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. React Components — individual primitive selectors                    │
│    Port 3000                                                           │
│                                                                         │
│    ┌────────────────────────────────────────────────────────────────┐  │
│    │ Predictive Intelligence Widget:                                │  │
│    │ - currentPrice = useTradingStore(selectCurrentPrice) → 333.48 │  │
│    │ - predictionData = useTradingStore(selectPredictionData)       │  │
│    │   → { signal: "BUY", confidence: 0.77, target_price: 340.98 } │  │
│    │ - Renders: BUY badge, Target: $340.98, Current: $333.48       │  │
│    │ - Δ = ((340.98 - 333.48) / 333.48) * 100 = +2.25%            │  │
│    └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│    ┌────────────────────────────────────────────────────────────────┐  │
│    │ Alpha Stream (SignalWidget):                                   │  │
│    │ - currentPrice = useTradingStore(selectCurrentPrice) → 333.48 │  │
│    │ - Renders: Execution Price: $333.48 (from store, NOT signal)  │  │
│    └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│    ┌────────────────────────────────────────────────────────────────┐  │
│    │ OrderBook:                                                      │  │
│    │ - currentPrice={unifiedPrice} prop → 333.48                    │  │
│    │ - Generates bids/asks around 333.48 with 0.4% spread           │  │
│    └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│    ┌────────────────────────────────────────────────────────────────┐  │
│    │ TVChart:                                                        │  │
│    │ - TradingView widget (independent, fetches own data)           │  │
│    │ - Symbol: BINANCE:AAPL (or relevant mapping)                   │  │
│    └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Anti-Patterns Eliminated

| Anti-Pattern                         | Before                                                           | After                                                        |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| **Dual polling**                     | `setInterval` + `useWebSocket` both called every 30s             | Single `useWebSocket` orchestrator                           |
| **Stale bar close fallback**         | `displayPrice = currentPrice \|\| predictionData?.current_price` | `unifiedPrice = currentPrice` (always live)                  |
| **Fake deterministic fallback**      | `signal: "HOLD"`, `confidence: 0.35`, fabricated indicators      | `signal: "NO_DATA"`, `confidence: 0.0`, `indicators: null`   |
| **Aggregate selector re-renders**    | `selectPredictionState` returned `{...}` causing infinite loops  | 9 individual primitive selectors                             |
| **Stale ML model weights**           | `_load_model()` loaded `.joblib` from disk                       | Always retrains on latest candles                            |
| **Missing degradation flags**        | No `warning` or `fallback` fields in response                    | `warning` + `fallback` + `livePriceSource` in every response |
| **SignalWidget reading signal prop** | `signal.price` used directly                                     | `selectCurrentPrice` from store (unified truth)              |

### Future Recommendations

1. **Add circuit breaker for Alpaca API** — If snapshot fails 3 times in a row, cache the last known live price and return it with `fallback: true` and `warning: "Alpaca snapshot temporarily unavailable, using cached price"`

2. **Add prediction deduplication** — If the same symbol is requested within 10s, return the cached prediction instead of recomputing (reduce Alpaca API costs)

3. **Add WebSocket push** — Re-enable `socket.io-client` on the frontend so the backend can push new predictions immediately instead of waiting for the 30s poll interval

4. **Add `degraded` UI indicator** — When `fallback: true` or `warning` is present, show a yellow/orange banner in the Predictive Intelligence widget: ⚠️ "Degraded Mode — Signal confidence may be reduced"
