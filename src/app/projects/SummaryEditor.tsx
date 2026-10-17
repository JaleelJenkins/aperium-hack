"use client";

import { useState, useTransition } from "react";
import { updateProjectSummaryAction } from "../actions";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";

const MAX = 1200;

/** Extracts a concise 1-sentence headline, optional stakeholder tags, and bullet points from a raw summary. */
function formatSummary(raw: string): { headline: string; contacts: string[]; details: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { headline: "", contacts: [], details: [] };

  const sentences = trimmed
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let first = sentences[0] ?? trimmed;
  const contacts: string[] = [];

  // Pull parenthetical stakeholder/role callouts (e.g. "(Dana Whitfield, principal; Marco Reyes, project architect)") into clean chips.
  first = first.replace(/\s*\(([^)]+)\)/g, (_m, inner: string) => {
    for (const part of inner.split(";")) {
      const clean = part.trim();
      if (clean) contacts.push(clean);
    }
    return "";
  });

  // If the first sentence has a colon list, keep the lead clause as the headline and move the list to details.
  const colonIdx = first.indexOf(":");
  const details: string[] = [];
  if (colonIdx > 0 && colonIdx < first.length - 1) {
    const lead = first.slice(0, colonIdx).trim();
    const rest = first.slice(colonIdx + 1).replace(/\.$/, "").trim();
    first = `${lead}.`;
    if (rest) details.push(`Scope: ${rest}`);
  }

  for (const s of sentences.slice(1)) {
    details.push(s.replace(/\.$/, ""));
  }

  return { headline: first, contacts, details };
}

/** Project summary with shortened, structured display and in-place editing. */
export function SummaryEditor({ projectId, summary }: { projectId: string; summary: string }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(summary);
  const [pending, start] = useTransition();
  const [toast, show] = useToast();

  function save() {
    start(async () => {
      const r = await updateProjectSummaryAction(projectId, draft);
      show(r.message, r.ok ? "ok" : "bad");
      if (r.ok) setEditing(false);
    });
  }

  if (!editing) {
    const { headline, contacts, details } = formatSummary(summary);
    return (
      <div className="proj-summary">
        {!headline ? (
          <p className="muted">No summary yet. Add one so incoming threads can be matched here.</p>
        ) : (
          <div className="proj-summary-formatted">
            <p className="proj-summary-headline">{headline}</p>
            {contacts.length > 0 && (
              <div className="proj-summary-contacts">
                {contacts.map((c) => (
                  <span key={c} className="proj-contact-chip">
                    {c}
                  </span>
                ))}
              </div>
            )}
            {details.length > 0 && (
              <>
                {expanded ? (
                  <ul className="proj-summary-bullets">
                    {details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="proj-summary-sub">{details[0]}</p>
                )}
              </>
            )}
            <div className="proj-summary-actions">
              {details.length > 1 && (
                <button type="button" className="link-btn" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? "Show less" : `+${details.length - 1} more detail${details.length - 1 === 1 ? "" : "s"}`}
                </button>
              )}
              <button
                type="button"
                className="btn ghost sm proj-edit-btn"
                onClick={() => {
                  setDraft(summary);
                  setEditing(true);
                }}
              >
                <Icon name="pencil" size={12} />
                Edit summary
              </button>
            </div>
          </div>
        )}
        {toast}
      </div>
    );
  }

  return (
    <div className="proj-summary editing">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        maxLength={MAX}
        autoFocus
        aria-label="Project summary"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <div className="row">
        <span className="muted small">
          Key contacts, deliverables, and email topics ({draft.trim().length}/{MAX})
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </button>
        <button className="btn primary sm" onClick={save} disabled={pending || draft.trim() === summary.trim()}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {toast}
    </div>
  );
}
