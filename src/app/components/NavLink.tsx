"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Sidebar link with the terracotta active indicator. */
export function NavLink({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  const pathname = usePathname();
  const path = href.split(/[?#]/)[0];
  const on = !href.includes("?") && !href.includes("#") && (path === "/" ? pathname === "/" : pathname.startsWith(path));
  return (
    <Link href={href} className={on ? "on" : undefined} title={title} scroll={!href.includes("?open=")}>
      {children}
    </Link>
  );
}
