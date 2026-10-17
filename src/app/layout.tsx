import type { Metadata } from "next";
import { listClientsForNav } from "@/lib/board";
import { getDb } from "@/lib/db";
import { Icon } from "./components/Icon";
import { hue, initials } from "./format";
import "./globals.css";

export const metadata: Metadata = {
  title: "Client Pulse",
  description: "Every AI claim about a client project is evidence-backed, model-reviewed and human-approved.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const clients = listClientsForNav(getDb());
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <a href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                <Icon name="spark" size={14} />
              </span>
              Client Pulse
            </a>
            <nav className="side-nav">
              <a href="/">
                <Icon name="board" size={15} />
                Board
              </a>
              <a href="/inbox">
                <Icon name="mail" size={15} />
                All mail
              </a>
            </nav>
            {clients.length > 0 && (
              <>
                <div className="side-label">Clients</div>
                <nav className="side-nav clients">
                  {clients.map((c) => (
                    <a key={c.id} href={`/#client-${c.id}`} title={`${c.projects} projects · ${c.health.replace("_", " ")}`}>
                      <span className="avatar sm" style={{ ["--h" as string]: hue(c.name) }} aria-hidden="true">
                        {initials(c.name)}
                      </span>
                      <span className="side-client">{c.name}</span>
                      <span className={`dot ${c.health}`} />
                    </a>
                  ))}
                </nav>
              </>
            )}
            <div className="side-foot">
              <Icon name="shield" size={13} />
              Drafts only. Nothing is sent without a person.
            </div>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
