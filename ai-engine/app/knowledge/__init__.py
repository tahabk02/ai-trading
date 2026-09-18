"""knowledge — the TEN-BOOK KNOWLEDGE CORE.

Pure reference implementations of the mathematical models extracted from ten
canonical trading / finance books. Every function is a real, named, published
formula with its book + chapter cited in the docstring — zero fabrication.

Modules (all importable, all pure, no I/O):
  book_murphy_ta       — Murphy, "Technical Analysis of the Financial Markets"
  book_chan            — Chan, "Quantitative Trading" / "Algorithmic Trading"
  book_lopez_prado     — López de Prado, "Advances in Financial Machine Learning"
  book_grinold_kahn    — Grinold & Kahn, "Active Portfolio Management"
  book_hull            — Hull, "Options, Futures, and Other Derivatives"
  book_shreve          — Shreve, "Stochastic Calculus for Finance II"
  book_cont_tankov     — Cont & Tankov, "Financial Modelling with Jump Processes"
  book_hasbrouck       — Hasbrouck, "Empirical Market Microstructure"
  book_ohara           — O'Hara, "Market Microstructure Theory"
  book_bouchaud        — Bouchaud & Potters, "Theory of Financial Risk"
"""

from __future__ import annotations

from typing import Dict

BOOK_REGISTRY: Dict[str, Dict[str, str]] = {
    "murphy_ta": {
        "book": "John J. Murphy, Technical Analysis of the Financial Markets",
        "module": "book_murphy_ta",
        "domain": "technical-analysis",
    },
    "chan": {
        "book": "Ernest P. Chan, Quantitative Trading / Algorithmic Trading",
        "module": "book_chan",
        "domain": "quantitative-trading",
    },
    "lopez_prado": {
        "book": "Marcos López de Prado, Advances in Financial Machine Learning",
        "module": "book_lopez_prado",
        "domain": "ml-finance",
    },
    "grinold_kahn": {
        "book": "Richard C. Grinold & Ronald N. Kahn, Active Portfolio Management",
        "module": "book_grinold_kahn",
        "domain": "active-portfolio",
    },
    "hull": {
        "book": "John C. Hull, Options, Futures, and Other Derivatives",
        "module": "book_hull",
        "domain": "derivatives",
    },
    "shreve": {
        "book": "Steven Shreve, Stochastic Calculus for Finance II",
        "module": "book_shreve",
        "domain": "stochastic-calculus",
    },
    "cont_tankov": {
        "book": "Rama Cont & Peter Tankov, Financial Modelling with Jump Processes",
        "module": "book_cont_tankov",
        "domain": "jump-processes",
    },
    "hasbrouck": {
        "book": "Joel Hasbrouck, Empirical Market Microstructure",
        "module": "book_hasbrouck",
        "domain": "market-microstructure",
    },
    "ohara": {
        "book": "Maureen O'Hara, Market Microstructure Theory",
        "module": "book_ohara",
        "domain": "market-microstructure-theory",
    },
    "bouchaud": {
        "book": "Jean-Philippe Bouchaud & Marc Potters, Theory of Financial Risk",
        "module": "book_bouchaud",
        "domain": "statistical-physics-finance",
    },
}

__all__ = ["BOOK_REGISTRY"]