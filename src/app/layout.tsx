import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Client Pulse",
  description: "Every AI claim about a client project is evidence-backed, model-reviewed and human-approved.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            Client Pulse
          </a>
          <nav>
            <a href="/">Inbox</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
