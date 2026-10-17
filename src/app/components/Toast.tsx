"use client";

import { useCallback, useEffect, useState } from "react";

/** Minimal confirmation toast: const [toast, show] = useToast(); ... {toast} */
export function useToast(ms = 3200): [React.ReactNode, (message: string, tone?: "ok" | "bad") => void] {
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad"; at: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), ms);
    return () => clearTimeout(t);
  }, [msg, ms]);
  const show = useCallback((text: string, tone: "ok" | "bad" = "ok") => setMsg({ text, tone, at: Date.now() }), []);
  const node = msg ? (
    <div className={`toast ${msg.tone}`} role="status" key={msg.at}>
      {msg.text}
    </div>
  ) : null;
  return [node, show];
}
