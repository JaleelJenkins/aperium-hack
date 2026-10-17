"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Sidebar link with instant optimistic active indicator on click. */
export function NavLink({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  const pathname = usePathname();
  const [optimisticPath, setOptimisticPath] = useState<string | null>(null);
  const path = href.split(/[?#]/)[0];

  useEffect(() => {
    setOptimisticPath(null);
  }, [pathname]);

  const activePath = optimisticPath ?? pathname;
  const isNavTab = !href.includes("?") && !href.includes("#");
  const on = isNavTab && (path === "/" ? activePath === "/" : activePath.startsWith(path));
  const pending = isNavTab && optimisticPath === path && pathname !== path;

  return (
    <Link
      href={href}
      prefetch={isNavTab ? true : undefined}
      className={on ? `on${pending ? " nav-pending" : ""}` : undefined}
      title={title}
      scroll={!href.includes("?open=")}
      onClick={() => {
        if (isNavTab && path !== pathname) setOptimisticPath(path);
      }}
    >
      {children}
    </Link>
  );
}
