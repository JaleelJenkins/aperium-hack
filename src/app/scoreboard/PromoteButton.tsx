"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { promotePairAction } from "../actions";
import { useToast } from "../components/Toast";

/** "Promote to default router": pins this pair globally, then refreshes every view. */
export function PromoteButton({ pairId, label, active, available }: { pairId: string; label: string; active: boolean; available: boolean }) {
  const router = useRouter();
  const [toast, show] = useToast();
  const [pending, startTransition] = useTransition();
  // The toast renders in every branch: after a successful promote this row becomes "active".
  if (active) return <><span className="active-pill mono">Default router</span>{toast}</>;
  if (!available) return <span className="muted mono" title="No provider adapter for this model yet">No adapter yet</span>;
  return (
    <>
      <button
        type="button"
        className="btn sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await promotePairAction(pairId, label);
            show(r.message, r.ok ? "ok" : "bad");
            router.refresh();
          })
        }
      >
        {pending ? "Promoting…" : "Promote to default"}
      </button>
      {toast}
    </>
  );
}
