import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { Instrument_Serif, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { getDb } from "@/lib/db";
import { caughtCount } from "@/lib/inspect";
import { Icon } from "./components/Icon";
import { NavLink } from "./components/NavLink";
import "./globals.css";

// Design system type scale: serif for page headers, sans for UI, mono for keys/evidence/metrics.
const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Reasoning Intelligence",
  description: "Every AI claim about a client project is evidence-backed, model-reviewed and human-approved.",
};

const getSidebarBadges = cache((db: ReturnType<typeof getDb>) => {
  const caught = caughtCount(db);
  const rules = (db.prepare(`SELECT COUNT(*) AS n FROM review_rules WHERE enabled = 1`).get() as { n: number }).n;
  const approvals = (db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE status = 'proposed'`).get() as { n: number }).n;
  const nextApproval = (db.prepare(`SELECT id FROM actions WHERE status = 'proposed' ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined)?.id;
  return { caught, rules, approvals, nextApproval };
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const db = getDb();
  const { caught, rules, approvals, nextApproval } = getSidebarBadges(db);
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span className="brand-text">
                <span className="brand-name">Reasoning Intelligence</span>
              </span>
            </Link>

            <div className="side-label">Portfolio</div>
            <nav className="side-nav">
              <NavLink href="/">
                <Icon name="board" size={15} />
                Board
              </NavLink>
              <NavLink href="/projects">
                <Icon name="folder" size={15} />
                Projects
              </NavLink>
            </nav>

            <div className="side-label">Queues &amp; trust</div>
            <nav className="side-nav queues">
              <NavLink href={nextApproval ? `/?open=action:${nextApproval}` : "/?view=attention"} title="Opens the next draft, task or New project? card waiting on you">
                <Icon name="mail" size={15} />
                Needs approval
                <span className={`side-count${approvals ? " hot" : ""}`}>{approvals}</span>
              </NavLink>
              <NavLink href="/?open=caught">
                <Icon name="shield" size={15} />
                Caught by review
                <span className={`side-count${caught ? " hot" : ""}`}>{caught}</span>
              </NavLink>
              <NavLink href="/rules">
                <Icon name="check" size={15} />
                Review rules
                <span className="side-count">{rules}</span>
              </NavLink>
              <NavLink href="/scoreboard">
                <Icon name="gauge" size={15} />
                Model scoreboard
              </NavLink>
              <NavLink href="/inbox">
                <Icon name="mail" size={15} />
                All mail
              </NavLink>
            </nav>

            <div className="side-foot">
              <Icon name="shield" size={13} />
              <span>
                Drafts only: <code>drafts.create</code>, never <code>messages.send</code>.
              </span>
            </div>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
