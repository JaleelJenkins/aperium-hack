"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { InsightInfo } from "@/lib/inspect";
import { dismissInsightAction } from "../actions";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

/**
 * Drawer footer for an insight card: open the signal it was raised on, or dismiss it.
 * Dismissing is audited and recomputes the project's health; a rule won't raise it again.
 */
export function InsightPanel({ i, status, signalHref, messageHref }: { i: InsightInfo; status: string; signalHref: string | null; messageHref: string | null }) {
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [toast, show] = useToast(5000);

  const dismiss = () =>
    start(async () => {
      const r = await dismissInsightAction(i.id, reason);
      show(r.message, r.ok ? "ok" : "bad");
      if (r.ok) setAsking(false);
    });

  return (
    <div className="approve-panel">
      {status === "open" ? (
        asking ? (
          <>
            <div className="approve-form">
              <input
                placeholder="Why dismiss? (optional, kept in the audit log)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
                autoFocus
              />
            </div>
            <div className="approve-buttons">
              <button className="btn primary" disabled={pending} onClick={dismiss}>
                <Icon name="check" size={14} />
                {pending ? "Dismissing…" : "Dismiss insight"}
              </button>
              <button className="btn" disabled={pending} onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="approve-buttons">
            {signalHref && (
              <Link className="btn" href={signalHref} scroll={false}>
                <Icon name="eye" size={13} />
                Open the item
              </Link>
            )}
            {messageHref && (
              <a className="btn" href={messageHref}>
                <Icon name="external" size={13} />
                Open message
              </a>
            )}
            <button className="btn" disabled={pending} onClick={() => setAsking(true)}>
              Dismiss
            </button>
          </div>
        )
      ) : (
        <div className="approve-q">
          <Icon name="check" size={13} />
          {status === "resolved" ? "Resolved: the condition no longer holds." : "Dismissed by a person."}
        </div>
      )}
      {toast}
    </div>
  );
}
