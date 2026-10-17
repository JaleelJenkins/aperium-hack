import type { DB } from "@/lib/db";
import { modelFamily } from "@/lib/router/leaderboard";
import { getLeaderboard, getRouterSettings, projectRouting, routeMessage } from "@/lib/router/store";
import { POLICY_LABEL } from "@/lib/router/types";
import { secs } from "../format";
import { Shell } from "./Drawer";
import { Icon } from "./Icon";
import { ProjectTuningForm } from "./ProjectTuningForm";

/** Per-project routing tuning (?open=tune:<projectId>), with a live preview of the project's mail. */
export function TuneDrawer({ db, projectId, closeHref }: { db: DB; projectId: string; closeHref: string }) {
  const project = db
    .prepare(`SELECT p.id, p.name, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`)
    .get(projectId) as { id: string; name: string; client_name: string } | undefined;
  if (!project) return null;
  const settings = getRouterSettings(db);
  const routing = projectRouting(db, projectId, settings);
  const leaderboard = getLeaderboard(db);
  const recent = db
    .prepare(
      `SELECT m.gmail_message_id AS id, m.subject FROM messages m JOIN threads t ON t.gmail_thread_id = m.thread_id
        WHERE t.project_id = ? ORDER BY m.received_at DESC LIMIT 5`,
    )
    .all(projectId) as { id: string; subject: string | null }[];
  const preview = recent.map((m) => ({ ...m, d: routeMessage(db, m.id, leaderboard, settings) }));

  return (
    <Shell
      closeHref={closeHref}
      title={
        <>
          <Icon name="refresh" size={14} />
          Project routing
        </>
      }
    >
      <div>
        <div className="drawer-title">
          {project.client_name} / {project.name}
        </div>
        <div className="drawer-sub">
          Routes with <strong>{POLICY_LABEL[routing.policy]}</strong>
          {routing.inherited ? " (inherited from the global default)" : " (project override)"}.
        </div>
      </div>

      <ProjectTuningForm
        projectId={project.id}
        current={routing.policy}
        inherited={routing.inherited}
        pinnedPairId={routing.pinnedPairId}
        defaultPolicy={settings.defaultPolicy}
        pairs={leaderboard.filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }))}
      />

      <div>
        <div className="d-section-label">
          <Icon name="mail" size={12} />
          Live preview: this project&apos;s recent mail
        </div>
        {preview.length ? (
          <div className="audit">
            {preview.map((m) =>
              m.d ? (
                <div className="audit-step" key={m.id}>
                  <span className="ico">
                    <Icon name="refresh" size={12} />
                  </span>
                  <div className="audit-who">
                    <span className="route-pair mono">
                      {modelFamily(m.d.selectedPair.reasonModel)} → {modelFamily(m.d.selectedPair.reviewModel)}
                    </span>
                    {m.d.wasEscalated && <span className="escalated-pill">Escalated</span>}
                    <span>{secs(m.d.estimatedLatencyMs)}</span>
                  </div>
                  <div className="audit-what">
                    <strong>{m.subject || "(no subject)"}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {m.d.routingReason}
                    </div>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No mail on this project yet.
          </p>
        )}
      </div>
    </Shell>
  );
}
