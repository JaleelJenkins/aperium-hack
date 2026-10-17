"use client";

import { useState, useTransition } from "react";
import { updateProjectSummaryAction } from "../actions";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toast";

const MAX = 1200;

/** Project summary with in-place editing. Resolve matches new email against this text. */
export function SummaryEditor({ projectId, summary }: { projectId: string; summary: string }) {
  const [editing, setEditing] = useState(false);
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
    return (
      <div className="proj-summary">
        <p>{summary || <span className="muted">No summary yet. Resolve needs one to file new threads here.</span>}</p>
        <button
          className="btn ghost sm"
          onClick={() => {
            setDraft(summary);
            setEditing(true);
          }}
        >
          <Icon name="pencil" size={13} />
          Edit
        </button>
        {toast}
      </div>
    );
  }

  return (
    <div className="proj-summary editing">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
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
          Name the people, the scope and the kind of mail this project gets. {draft.trim().length}/{MAX}
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
