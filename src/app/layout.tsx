import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { listClientsForNav } from "@/lib/board";
import { getDb } from "@/lib/db";
import { caughtCount } from "@/lib/inspect";
import { Icon } from "./components/Icon";
import { NavLink } from "./components/NavLink";
import { hue, initials } from "./format";
import "./globals.css";

// Design system type scale: serif for page headers, sans for UI, mono for keys/evidence/metrics.
const serif = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Client Pulse",
  description: "Every AI claim about a client project is evidence-backed, model-reviewed and human-approved.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const db = getDb();
  const clients = listClientsForNav(db);
  const caught = caughtCount(db);
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <a href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span className="brand-text">
                <span className="brand-name">Client Pulse</span>
                <span className="brand-by">by Aperium</span>
              </span>
            </a>

            <div className="side-label">Portfolio</div>
            <nav className="side-nav">
              <NavLink href="/">
                <Icon name="board" size={15} />
                Board
              </NavLink>
            </nav>
            {clients.length > 0 && (
              <nav className="side-nav clients">
                {clients.map((c) => (
                  <NavLink key={c.id} href={`/#client-${c.id}`} title={`${c.projects} projects · ${c.health.replace("_", " ")}`}>
                    <span className="avatar sm" style={{ ["--h" as string]: hue(c.name) }} aria-hidden="true">
                      {initials(c.name)}
                    </span>
                    <span className="side-client">{c.name}</span>
                    <span className={`dot ${c.health}`} />
                  </NavLink>
                ))}
              </nav>
            )}

            <div className="side-label">Queues &amp; trust</div>
            <nav className="side-nav queues">
              <NavLink href="/?open=caught">
                <Icon name="shield" size={15} />
                Caught by review
                <span className={`side-count${caught ? " hot" : ""}`}>{caught}</span>
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
