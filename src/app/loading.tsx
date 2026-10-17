/**
 * Instant route-level loading state while an uncached page segment resolves.
 * Matches the warm editorial layout so transitions never block or jump.
 */
export default function Loading() {
  return (
    <div className="route-loading" aria-busy="true" aria-live="polite">
      <div className="route-loading-bar" />
      <div className="page-head">
        <div>
          <div className="skel skel-eyebrow" />
          <div className="skel skel-title" />
          <div className="skel skel-sub" />
        </div>
      </div>
      <div className="skel-grid">
        <div className="skel skel-card" />
        <div className="skel skel-card" />
        <div className="skel skel-card" />
      </div>
    </div>
  );
}
