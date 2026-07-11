'use client';

import type { CSSProperties } from 'react';
import type { SieveStage } from '@/lib/verdict';

export interface SieveProps {
  stages: SieveStage[];
}

/**
 * DOM id of the coin table this stage's final segment scrolls to. Owned by whatever renders the
 * screened-coins table (page.tsx / components/watchlist) — that element must carry this id for
 * the button below to do anything.
 */
const SCREENED_COINS_ID = 'screened-coins';

/**
 * Fixed taper per stage key so the funnel silhouette narrows left->right regardless of which
 * stages sieveStages() actually returns (it omits stages with missing data).
 * Floor is 58px, not less: a segment still has to fit its own count + label, and anything
 * shorter clips the text against the box it lives in.
 */
const SEGMENT_HEIGHT_PX: Record<SieveStage['key'], number> = {
  scanned: 92,
  priced: 80,
  trusted: 68,
  shortlisted: 58,
};

/**
 * `--seg-h`/`--i` are CSS custom properties .sieve-seg reads for its taper and staggered grow-in
 * animation (see app/globals.css). CSSProperties intentionally has no index signature for them
 * (see the type's own doc comment in @types/react) -- this narrow, documented assertion is the
 * sanctioned way to add them, not an escape hatch.
 */
type SieveSegStyle = CSSProperties & { '--seg-h': string; '--i': number };

/**
 * Jump to the coin table.
 *
 * Deliberately not a bare `scrollIntoView({behavior: 'smooth'})`: some Chrome builds accept that
 * call and silently never scroll, which makes the button look wired up while doing nothing. So we
 * ask for smooth, then check we actually moved and hard-jump if we didn't. Honours reduced-motion.
 */
function scrollToScreenedCoins(): void {
  const target = document.getElementById(SCREENED_COINS_ID);
  if (!target) return;

  const top = target.getBoundingClientRect().top + window.scrollY;
  const startY = window.scrollY;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });

  if (reduceMotion) return;
  // If smooth scrolling is a no-op here, we won't have budged at all — land it instantly instead.
  window.setTimeout(() => {
    if (window.scrollY === startY) window.scrollTo(0, top);
  }, 250);
}

/**
 * The signature element: a horizontal funnel of real pipeline counts (scanned -> priced ->
 * trusted -> shortlisted). Client component only because the final segment needs an onClick --
 * everything else about the stage (verdict, stat tiles) stays server-rendered.
 */
export function Sieve({ stages }: SieveProps) {
  if (stages.length === 0) return null;

  return (
    <fieldset
      className="sieve m-0 border-0 p-0"
      aria-label="Screening funnel, scanned to shortlisted"
    >
      {stages.map((stage, index) => {
        const style: SieveSegStyle = {
          '--seg-h': `${SEGMENT_HEIGHT_PX[stage.key]}px`,
          '--i': index,
        };

        if (stage.key !== 'shortlisted') {
          return (
            <div key={stage.key} className="sieve-seg" style={style}>
              <span className="sieve-count">{stage.count}</span>
              <span className="sieve-label">{stage.label}</span>
            </div>
          );
        }

        return (
          <button
            key={stage.key}
            type="button"
            className="sieve-seg final"
            style={style}
            onClick={scrollToScreenedCoins}
          >
            <span className="sieve-count">{stage.count}</span>
            <span className="sieve-label">{stage.label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
