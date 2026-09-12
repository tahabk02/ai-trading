"use client";

import { useEffect, useState } from "react";
import { detectLang, isRTL, type Lang } from "@/utils/i18n";

export function useLang() {
  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    const detected = detectLang();
    setLang(detected);
  }, []);

  return {
    lang,
    rtl: isRTL(lang),
  };
}
