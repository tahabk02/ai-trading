"""
Root entry point for the Zero-Demo AI Engine.

This is the canonical runner invoked by production start commands
(`python main.py` or `uvicorn main:app`). All real market data
acquisition, dynamic technical-indicator math (EMA, RSI, MACD, volume
momentum), live-tick aggregation, and unbiased CALL/PUT signal generation
live in the `app/` package — specifically `app.main` (FastAPI application),
`app.services.quant_matrix` / `app.services.signal_generator` (real-time
quant engine), and `app.data.collector` (Yahoo Finance / CoinGecko / FRED /
Frankfurter fetches — zero randomness, zero fallback arrays).
"""

import uvicorn

from app.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)