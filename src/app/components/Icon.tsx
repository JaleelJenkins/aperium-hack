/** Small stroke icons (lucide-style paths, inlined so there's no icon dependency). */
const PATHS = {
  board: "M3 3h7v18H3zM14 3h7v10h-7z",
  mail: "M4 4h16v16H4zM4 6l8 7 8-7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  alert: "M12 3l10 18H2zM12 10v4M12 17.5v.5",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  check: "M5 12l5 5 9-10",
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  chevron: "M6 9l6 6 6-6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  zap: "M13 2L4 14h7l-1 8 9-12h-7z",
  image: "M4 4h16v16H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01",
  x: "M6 6l12 12M18 6L6 18",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  gauge: "M12 14l4-4M4 18a9 9 0 1 1 16 0",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
