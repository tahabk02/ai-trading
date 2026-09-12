"use client";

import React, { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export const RiskDisclaimerBanner: React.FC = () => {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <div className="bg-gradient-to-r from-amber-500/10 via-amber-600/5 to-transparent border-b border-amber-500/20">
      <div className="max-w-full mx-auto px-6 py-3 flex items-start gap-3">
        <AlertTriangle
          size={18}
          className="text-amber-400 mt-0.5 shrink-0 animate-pulse"
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-amber-300 uppercase tracking-wider">
            Risk Disclaimer
          </p>
          <p className="text-[10px] text-amber-400/70 mt-0.5 leading-relaxed">
            This platform provides AI-generated trading signals for
            informational and educational purposes only. It does not constitute
            financial advice. Past performance is not indicative of future
            results. Trading cryptocurrencies, stocks, and other financial
            instruments involves substantial risk of loss. You should consult
            with a qualified financial advisor before making any trading
            decisions. The developers and operators of this platform assume no
            liability for any trading losses incurred.
          </p>
        </div>
        <button
          onClick={() => setVisible(false)}
          className="text-amber-400/60 hover:text-amber-300 transition-colors shrink-0 mt-0.5"
          aria-label="Dismiss disclaimer"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default RiskDisclaimerBanner;
