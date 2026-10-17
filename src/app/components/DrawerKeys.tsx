"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Esc closes the evidence drawer without losing the board's scroll position. */
export function DrawerKeys({ closeHref }: { closeHref: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.replace(closeHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, closeHref]);
  return null;
}
