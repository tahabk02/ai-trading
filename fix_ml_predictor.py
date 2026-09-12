"""Fix the truncated tail of ml_predictor.py"""
import pathlib

path = pathlib.Path("c:/Users/hp/trading-ai-platform/ai-engine/app/services/ml_predictor.py")
content = path.read_text(encoding="utf-8")

# Find the broken ending
broken = (
    '            "rsi_14": round(rsi14, 2), "sma_10": round(sma20, 2),\n'
    '            "sma_20": round(sma20, 2), "sma_50":'
)

replacement = (
    '            "rsi_14": round(rsi14, 2), "sma_10": round(sma20, 2),\n'
    '            "sma_20": round(sma20, 2), "sma_50": round(sma50, 2),\n'
    '            "ema_5_slope": round(e5s, 4), "ema_21_slope": round(e21s, 4),\n'
    '            "macd_fast": round(macd, 6), "stoch_k": round(sk, 2),\n'
    '            "stoch_d": round(sd, 2), "atr_14": round(atr, 6),\n'
    "        },\n"
    '        "indicators": {\n'
    '            "rsi_14": round(rsi14, 2), "sma_10": round(sma20, 2),\n'
    '            "sma_20": round(sma20, 2), "sma_50": round(sma50, 2),\n'
    "        },\n"
    '        "timestamp": datetime.utcnow().isoformat(),\n'
    "    }\n"
    "\n"
    "    if cp > 0:\n"
    '        delta = ((tp - cp) / cp) * 100.0\n'
    '        response["delta_pct"] = round(max(-100.0, min(100.0, delta)), 2)\n'
    "    else:\n"
    '        response["delta_pct"] = 0.0\n'
    "\n"
    '    logger.info("Prediction complete", symbol=symbol, signal=sig, confidence=conf,\n'
    "                prob_up=round(prob_up, 4), accuracy=round(accuracy, 4),\n"
    "                total_ms=round(total_ms, 2), momentum=mom, cache_hit=cache_hit)\n"
    "    return response\n"
)

if broken in content:
    content = content.replace(broken, replacement)
    path.write_text(content, encoding="utf-8")
    print("SUCCESS: File repaired")
else:
    print("FAILED: Could not find exact match")
    idx = content.find(broken[:30])
    if idx >= 0:
        print(f"Partial match at index {idx}")
        print("Found near: ", repr(content[idx:idx+100]))
    else:
        print("No partial match either")
        print("Last 200 chars:")
        print(repr(content[-200:]))
</｜DSML｜parameter>
</create_file>
