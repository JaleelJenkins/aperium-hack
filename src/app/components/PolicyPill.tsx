"use client";

import { useRouter } from "next/navigation";

/**
 * Project routing policy pill in a lane header. It sits inside the lane's <summary>, so it
 * stops the click from collapsing the lane and navigates to the tuning drawer itself.
 */
export function PolicyPill({ href, label, inherited }: { href: string; label: string; inherited: boolean }) {
  const router = useRouter();
  return (
    <a
      className="policy-pill"
      href={href}
      title="Routing policy for this project: click to tune"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        router.push(href, { scroll: false });
      }}
    >
      ⇄ {label}
      {inherited && <span className="inh">· default</span>}
    </a>
  );
}
