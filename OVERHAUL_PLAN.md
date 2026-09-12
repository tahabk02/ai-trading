# Comprehensive Production Overhaul Plan

## Information Gathered

After thorough analysis of the entire codebase, here are the critical issues identified:

### 1. Price Formatting Bugs (Mock Decimal Precision)

- **`financial-chart.tsx`**: Uses `currentPrice.toFixed(2)` and `predictedTargetPrice!.toFixed(2)` — always 2 decimals, wrong for JPY pairs (need 3) and other pairs (need 5)
- **`trading-panel.tsx`**: Uses `currentPrice.toFixed(2)` — hardcoded 2 decimals
- **`order-book.tsx`**: `formatPrice()` uses `minimumFractionDigits: 2, maximumFractionDigits: 2` — should use `formatPairPrice()` with pair-aware digits
- **`predictive-intelligence.tsx`**: Uses `formatCurrency()` which hardcodes 2 decimals for target/current price display
- **`format.ts`**: `formatCurrency()` and `formatNumber()` default to 2 decimals — these are used across the UI

### 2. Candlestick Visualization (financial-chart.tsx)

- Candles render correctly but the EMA(12) curve dominates visually
- Need to ensure candles have distinct bodies with clear green/red wicks
- The gap calculation (`plotW / Math.max(1, chartData.length - 1)`) could cause overlapping candles when data is dense

### 3. Multi-Timeframe Synchronization (1m-35m+)

- **`trading-panel.tsx`**: Has 10 expiry buttons (1m-35m+) but only calls `setExpirationSeconds` — doesn't trigger prediction re-fetch
- **`predictive-intelligence.tsx`**: Only has 5 timeframe options (1m, 5m, 15m, 1h, 1d) — missing 2m, 3m, 10m, 20m, 25m, 30m, 35m+
- **`signals.py`**: `_safeguard_target_price()` now has all 10 timeframes mapped (1m, 2m, 3m, 5m, 10m, 15m, 20m, 25m, 30m, 35m+, 1h, 4h, 1d) ✓
- **`signal_gen.py`**: Only has 1m, 5m, 15m, 1h, 4h, 1d — missing 2m, 3m, 10m, 20m, 25m, 30m, 35m+
- **`ml_predictor.py`**: Only has 1m, 5m, 15m, 1h, 4h, 1d — missing 2m, 3m, 10m, 20m, 25m, 30m, 35m+
- **`signal.controller.ts`**: `TIMEFRAME_DESIRED_BARS` only has 1m, 5m, 15m, 30m, 1h, 4h, 1d — missing 2m, 3m, 10m, 20m, 25m, 35m+
- **`forexData.service.ts`**: `computeTargetPrice()` and `computeVolatilityBand()` only have 1m, 5m, 15m, 30m, 1h, 4h, 1d horizon map
- **`schemas.py`**: `validate_timeframe` only allows 1m, 5m, 15m, 30m, 1h, 4h, 1d

### 4. Inter-Page Consistency

- **Settings → Terminal**: `storeSetTimeframe(updated.timeframe)` propagates correctly ✓
- **Risk Rules → Trading**: Risk rules are persisted to DB but `executeTrade()` in the store doesn't check risk rules before executing
- **Global Settings → AI Engine**: `confidenceGuardrail` is stored in DB but not propagated to the AI engine's `CONFIDENCE_THRESHOLD`

### 5. Mock Data / Hardcoded Fallbacks

- **`predictive-intelligence.tsx`**: `"32ms"` hardcoded fallback for proxyLatencyMs — should use `"--"` or `null`
- **`order-book.tsx`**: `formatPrice()` uses hardcoded USD currency formatting — should use pair-aware `formatPairPrice()`
- **`format.ts`**: `formatCurrency()` uses `currency: "USD"` — forex pairs have different quote currencies
- **`trading-panel.tsx`**: `currentPrice.toFixed(2)` always shows 2 decimals — wrong for JPY pairs

---

## Plan

### Phase 1: Fix Price Formatting (All Frontend Components)

**Files to edit:**

1. `client-app/src/utils/format.ts` — Add `formatPairPriceSmart()` that auto-detects quote currency from symbol
2. `client-app/src/components/trading/financial-chart.tsx` — Replace all `.toFixed(2)` with `formatPairPrice()`
3. `client-app/src/components/trading/trading-panel.tsx` — Replace all `.toFixed(2)` with `formatPairPrice()`
4. `client-app/src/components/trading/order-book.tsx` — Replace `formatPrice()` with `formatPairPrice()` using pair-aware digits
5. `client-app/src/components/trading/predictive-intelligence.tsx` — Replace `formatCurrency()` with `formatPairPrice()` for prices

### Phase 2: Redesign Candlestick Chart

**Files to edit:** 6. `client-app/src/components/trading/financial-chart.tsx` — Enhance candlestick rendering with:

- Wider candle bodies for better visibility
- Clearer high/low wicks (thinner lines)
- Better gap handling for dense data
- Optional volume bars at bottom

### Phase 3: Multi-Timeframe Synchronization (All Layers)

**Files to edit:** 7. `client-app/src/components/trading/predictive-intelligence.tsx` — Add all 10 timeframe options (1m-35m+) 8. `client-app/src/store/useTradingStore.ts` — Link `setExpirationSeconds` to trigger `getPrediction()` with the correct timeframe 9. `client-app/src/components/trading/trading-panel.tsx` — When expiration changes, trigger prediction re-fetch 10. `ai-engine/app/api/v1/schemas.py` — Add 2m, 3m, 10m, 20m, 25m, 35m+ to valid timeframe list 11. `ai-engine/app/services/signal_generator.py` — Add 2m, 3m, 10m, 20m, 25m, 30m, 35m+ timeframe multipliers 12. `ai-engine/app/services/ml_predictor.py` — Add 2m, 3m, 10m, 20m, 25m, 30m, 35m+ timeframe multipliers 13. `core-backend/src/services/forexData.service.ts` — Add 2m, 3m, 10m, 20m, 25m, 35m+ to horizon map 14. `core-backend/src/controllers/signal.controller.ts` — Add 2m, 3m, 10m, 20m, 25m, 35m+ to TIMEFRAME_DESIRED_BARS

### Phase 4: Inter-Page Consistency

**Files to edit:** 15. `client-app/src/store/useTradingStore.ts` — Add risk rule enforcement in `executeTrade()` 16. `core-backend/src/controllers/settings.controller.ts` — Propagate confidenceGuardrail to AI engine via API 17. `client-app/src/app/(dashboard)/settings/page.tsx` — Add risk rule status display

### Phase 5: Eliminate Remaining Mock/Hardcoded Values

**Files to edit:** 18. `client-app/src/components/trading/predictive-intelligence.tsx` — Replace `"32ms"` fallback with `"--"` 19. `client-app/src/components/trading/order-book.tsx` — Use `formatPairPrice()` from `@/utils/format` instead of local `formatPrice()` 20. `client-app/src/utils/format.ts` — Add `formatQuoteCurrency()` helper for non-USD pairs

### Dependent Files

- `client-app/src/components/trading/financial-chart.tsx`
- `client-app/src/components/trading/trading-panel.tsx`
- `client-app/src/components/trading/order-book.tsx`
- `client-app/src/components/trading/predictive-intelligence.tsx`
- `client-app/src/store/useTradingStore.ts`
- `client-app/src/utils/format.ts`
- `ai-engine/app/api/v1/schemas.py`
- `ai-engine/app/api/v1/signals.py` (already fixed)
- `ai-engine/app/services/signal_generator.py`
- `ai-engine/app/services/ml_predictor.py`
- `core-backend/src/services/forexData.service.ts`
- `core-backend/src/controllers/signal.controller.ts`
- `core-backend/src/controllers/settings.controller.ts`

### Followup Steps

1. Run `npm run build` in client-app to verify zero TypeScript compilation errors
2. Run `python -m py_compile` on Python files to verify syntax
3. Verify no hardcoded `.toFixed(2)` remains in the codebase
4. Verify all 10 timeframes (1m-35m+) are properly handled end-to-end
