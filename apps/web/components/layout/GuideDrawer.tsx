'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { dismissGuidePatch, guideDismissed } from '@/lib/guide';
import { readPrefs, writePrefs } from '@/lib/prefs';

/**
 * "How to read this screener" -- a dismissible, plain-English guide for readers with no futures
 * background. Reuses the `.panel` shell (same background/border/radius as every other panel on
 * the page) and Panel's own header layout, rather than importing Panel itself: Panel's prop
 * contract has no room for the `role="dialog"`/`aria-modal` a modal needs, and widening a shared
 * component just for this one caller is out of scope here.
 */
export function GuideDrawer() {
  const [open, setOpen] = useState(false);

  function close() {
    setOpen(false);
    writePrefs(dismissGuidePatch());
  }

  // Post-mount only, matching WatchlistWorkbench's sort-prefs sync: server-safe default (closed)
  // renders first (no hydration mismatch), then this opens it for a visitor who has never
  // dismissed it before.
  useEffect(() => {
    if (!guideDismissed(readPrefs())) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        writePrefs(dismissGuidePatch());
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 border border-line bg-panel text-ink rounded-md px-2.5 text-[13px] font-semibold cursor-pointer"
      >
        How to read
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
          {/* A real button, not a click handler on a static div, so the backdrop is keyboard- and
              screen-reader-accessible on its own terms. Off the tab order (Escape and the explicit
              close button already cover keyboard users) so Tab goes straight into the dialog. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close guide"
            onClick={close}
            className="fixed inset-0 z-0 cursor-default bg-black/60"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            className="panel relative z-10 w-full max-w-[640px] my-0 sm:my-6 max-h-full overflow-y-auto"
          >
            <div className="flex justify-between items-center gap-2 min-h-[42px] px-3 py-2.5 bg-panel-2 border-b border-line sticky top-0">
              <h2 id="guide-title" className="m-0 text-xs font-semibold uppercase tracking-wide">
                How to read this screener
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close guide"
                className="h-7 w-7 inline-flex items-center justify-center border border-line bg-panel text-ink rounded-md cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="grid gap-4 p-4 text-[13px] text-ink leading-relaxed">
              <GuideSection title="What this is">
                <p className="m-0">
                  A ranked shortlist of futures markets worth reviewing by hand — not trade signals.
                  Nothing here executes a trade or promises an outcome.
                </p>
              </GuideSection>

              <GuideSection title="Reading order">
                <p className="m-0">
                  Read top to bottom: the market verdict first (is there any direction today at
                  all?), then breadth &amp; rotation (how broad is it — one sector, or the whole
                  market?), then the majors (BTC/ETH/SOL, for context, not candidates), and only
                  then the watchlists below.
                </p>
              </GuideSection>

              <GuideSection title="The four lists, in plain words">
                <dl className="m-0 grid gap-2">
                  <GuideTerm term="Longs">
                    Rising with futures confirmation — price up, backed by open interest and
                    positioning, not just spot drifting.
                  </GuideTerm>
                  <GuideTerm term="Shorts">
                    Falling on their own weakness, not just following BTC down.
                  </GuideTerm>
                  <GuideTerm term="Long Fades">
                    Everyone is already long — a crowded trade, not a fresh one.
                  </GuideTerm>
                  <GuideTerm term="Squeeze Risk">
                    Heavy short positioning that could get forced to cover.
                  </GuideTerm>
                </dl>
              </GuideSection>

              <GuideSection title="Row anatomy">
                <dl className="m-0 grid gap-2">
                  <GuideTerm term="24h">Plain price change over the last 24 hours.</GuideTerm>
                  <GuideTerm term="Volume">
                    24h dollar turnover on the primary exchange — raw activity, not a ranking input.
                  </GuideTerm>
                  <GuideTerm term="OI 24h">
                    Open interest change — money entering or leaving open futures positions.
                  </GuideTerm>
                  <GuideTerm term="Funding">
                    What longs pay shorts (or shorts pay longs) to hold their position — a crowding
                    meter.
                  </GuideTerm>
                  <GuideTerm term="Crowding">
                    The long/short account ratio — how one-sided current positioning is.
                  </GuideTerm>
                  <GuideTerm term="BTC corr">How closely this coin tracks BTC.</GuideTerm>
                  <GuideTerm term="Smart $">
                    Top traders&rsquo; positioning vs. the broader crowd&rsquo;s.
                  </GuideTerm>
                </dl>
              </GuideSection>

              <GuideSection title="The fakeout protections">
                <p className="m-0">
                  The scenario this whole page is built to catch: you short a falling coin. BTC
                  pumps. Your coin gets dragged up with it and stops you out — even though nothing
                  about the coin itself changed.
                </p>
                <ul className="m-0 mt-2 grid gap-1.5 pl-4 list-disc">
                  <li>
                    <strong>BTC corr + BTC beta</strong> say how chained the coin is to BTC, and how
                    hard a BTC move hits it.
                  </li>
                  <li>
                    <strong>Residual 24h</strong> is the coin&rsquo;s own move with BTC&rsquo;s pull
                    subtracted out — the ranking now uses this, so &ldquo;weak because BTC
                    fell&rdquo; no longer tops the shorts list.
                  </li>
                  <li>
                    A red <strong>Fights BTC</strong> chip means BTC is moving against this trade
                    right now.
                  </li>
                  <li>
                    The <strong>OI/price read</strong> tells fresh positioning apart from a washout
                    or a weak rally.
                  </li>
                  <li>
                    A yellow banner above a list means BTC has moved since this data was computed —
                    that list may already be stale.
                  </li>
                </ul>
              </GuideSection>

              <GuideSection title="Before acting">
                <p className="m-0">
                  Open the chart yourself. Check the setup holds up. Mind your position size. Every
                  ⓘ on this page defines the term next to it.
                </p>
              </GuideSection>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <div className="label">{title}</div>
      {children}
    </section>
  );
}

function GuideTerm({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(88px,auto)_1fr] gap-2 items-baseline">
      <dt className="font-semibold text-ink">{term}</dt>
      <dd className="m-0 text-muted">{children}</dd>
    </div>
  );
}
