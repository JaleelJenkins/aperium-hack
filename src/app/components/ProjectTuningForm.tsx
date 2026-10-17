"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RoutingPolicyMode } from "@/lib/router/types";
import { POLICY_HINT, POLICY_LABEL, POLICY_MODES } from "@/lib/router/types";
import { setProjectPolicyAction } from "../actions";
import { useToast } from "./Toast";

/** Per-project routing override. "inherit" clears the override so the global default applies. */
export function ProjectTuningForm({
  projectId,
  current,
  inherited,
  pinnedPairId,
  defaultPolicy,
  pairs,
}: {
  projectId: string;
  current: RoutingPolicyMode;
  inherited: boolean;
  pinnedPairId: string;
  defaultPolicy: RoutingPolicyMode;
  pairs: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [toast, show] = useToast();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<RoutingPolicyMode | "inherit">(inherited ? "inherit" : current);
  const [pin, setPin] = useState(pinnedPairId);
  const dirty = choice !== (inherited ? "inherit" : current) || (choice === "pinned" && pin !== pinnedPairId);

  function save() {
    startTransition(async () => {
      const r = await setProjectPolicyAction(projectId, choice === "inherit" ? null : choice, choice === "pinned" ? pin : null);
      show(r.message, r.ok ? "ok" : "bad");
      router.refresh();
    });
  }

  return (
    <div>
      <div className="tune-options" role="radiogroup" aria-label="Routing policy">
        <label className={`tune-option${choice === "inherit" ? " on" : ""}`}>
          <input type="radio" name="policy" checked={choice === "inherit"} onChange={() => setChoice("inherit")} />
          <span className="t-name">Inherit global default</span>
          <span className="t-hint">Currently {POLICY_LABEL[defaultPolicy]}. Changes on the scoreboard apply here too.</span>
        </label>
        {POLICY_MODES.map((m) => (
          <label key={m} className={`tune-option${choice === m ? " on" : ""}`}>
            <input type="radio" name="policy" checked={choice === m} onChange={() => setChoice(m)} />
            <span className="t-name">{POLICY_LABEL[m]}</span>
            <span className="t-hint">{POLICY_HINT[m]}</span>
            {m === "pinned" && choice === "pinned" && (
              <select value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Pinned pair">
                {pairs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button type="button" className="btn primary" onClick={save} disabled={!dirty || pending}>
          {pending ? "Saving…" : "Save routing policy"}
        </button>
        {!dirty && <span className="muted" style={{ fontSize: 12 }}>No changes</span>}
      </div>
      {toast}
    </div>
  );
}
