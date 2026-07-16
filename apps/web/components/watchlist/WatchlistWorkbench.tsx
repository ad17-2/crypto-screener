'use client';

import type { Watchlist, WatchlistId } from '@crypto-screener/contracts';
import { useEffect, useMemo, useState } from 'react';
import {
  BTC_PULSE_POLL_MS,
  btcDeltaPct,
  pulseChipText,
  stalenessBannerText,
  threatenedSide,
} from '@/lib/btc-pulse';
import { rowKey } from '@/lib/dashboard-row';
import { readPrefs, writePrefs } from '@/lib/prefs';
import type { WatchlistFilterState } from '@/lib/watchlist-filters';
import { DEFAULT_WATCHLIST_FILTERS, filterRows } from '@/lib/watchlist-filters';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';
import { defaultSortDirection, sortRows } from '@/lib/watchlist-sort';
import { SelectedCoinRail } from './SelectedCoinRail';
import { WatchlistPanel } from './WatchlistPanel';

export interface WatchlistWorkbenchProps {
  watchlists: Watchlist[];
  /** BTC's price_usd at the time this run was computed, from the core section -- null on old runs
   * or when BTC has no core row. Feeds the staleness poll against GET /api/btc-pulse below. */
  runBtcPrice: number | null;
}

const SORT_KEYS: readonly SortColumnKey[] = [
  'rank',
  'symbol',
  'setup',
  'price',
  'volume',
  'oi',
  'funding',
  'crowding',
  'btc_correlation',
  'positioning_divergence',
];

function defaultTab(watchlists: Watchlist[]): WatchlistId {
  return watchlists.some((list) => list.id === 'chart_next')
    ? 'chart_next'
    : (watchlists[0]?.id ?? 'chart_next');
}

export function WatchlistWorkbench({ watchlists, runBtcPrice }: WatchlistWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WatchlistId>(() => defaultTab(watchlists));
  const [filters, setFilters] = useState<WatchlistFilterState>(DEFAULT_WATCHLIST_FILTERS);
  const [sortKey, setSortKey] = useState<SortColumnKey | null>('rank');
  const [sortDir, setSortDir] = useState<SortDirection>(() => defaultSortDirection('rank'));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [btcPulse, setBtcPulse] = useState<{ livePrice: number; deltaPct: number } | null>(null);

  // Post-mount only, matching ThemeProvider: server-safe default (rank / API order) renders first
  // (no hydration mismatch), then this syncs from localStorage once a saved sort is known.
  useEffect(() => {
    const prefs = readPrefs();
    const matchedSortKey = SORT_KEYS.find((key) => key === prefs.sortKey);
    if (matchedSortKey) setSortKey(matchedSortKey);
    if (prefs.sortDir === 'asc' || prefs.sortDir === 'desc') setSortDir(prefs.sortDir);
  }, []);

  // The BTC fakeout tripwire: poll near-live BTC against the price this run was computed at.
  // First fetch on mount, then every BTC_PULSE_POLL_MS; paused while the tab is hidden (each tick
  // just skips the fetch, so polling resumes on the next tick after the tab regains focus).
  // Fetch failure or a 503 (btc-pulse temporarily unavailable) hides the feature silently -- it
  // must never block or error the rest of the page.
  useEffect(() => {
    if (runBtcPrice === null) return undefined;
    let cancelled = false;

    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch('/api/btc-pulse', { cache: 'no-store' });
        if (!response.ok) return;
        const body: unknown = await response.json();
        const price =
          body &&
          typeof body === 'object' &&
          typeof (body as { price_usd?: unknown }).price_usd === 'number'
            ? (body as { price_usd: number }).price_usd
            : null;
        if (price === null) return;
        const deltaPct = btcDeltaPct(price, runBtcPrice);
        if (!cancelled && deltaPct !== null) setBtcPulse({ livePrice: price, deltaPct });
      } catch {
        // network failure -- hide silently, never block render
      }
    };

    poll();
    const interval = window.setInterval(poll, BTC_PULSE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [runBtcPrice]);

  const btcPulseChip = btcPulse ? pulseChipText(btcPulse.livePrice, btcPulse.deltaPct) : null;
  const btcPulseSide = btcPulse ? threatenedSide(btcPulse.deltaPct) : null;
  // Only over the list it threatens -- a BTC pump's banner shows over Shorts, a dump's over Longs.
  const btcStalenessBanner =
    btcPulse && btcPulseSide && btcPulseSide === activeTab
      ? stalenessBannerText(btcPulse.deltaPct, btcPulseSide)
      : null;

  const activeList = useMemo(
    () =>
      watchlists.find((list) => list.id === activeTab) ??
      watchlists[0] ?? { id: activeTab, label: 'Watchlist', rows: [] },
    [watchlists, activeTab],
  );

  const visibleRows = useMemo(
    () => sortRows(filterRows(activeList.rows, filters), sortKey, sortDir),
    [activeList, filters, sortKey, sortDir],
  );

  const effectiveSelectedKey = useMemo(() => {
    if (selectedKey && visibleRows.some((row) => rowKey(row) === selectedKey)) return selectedKey;
    return visibleRows[0] ? rowKey(visibleRows[0]) : null;
  }, [visibleRows, selectedKey]);

  const selectedRow = visibleRows.find((row) => rowKey(row) === effectiveSelectedKey) ?? null;

  const handleTabChange = (id: WatchlistId) => {
    setActiveTab(id);
    setSelectedKey(null);
  };

  const handleFiltersChange = (patch: Partial<WatchlistFilterState>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
  };

  const handleSort = (key: SortColumnKey) => {
    if (sortKey === key) {
      const nextDir = sortDir === 'asc' ? 'desc' : 'asc';
      setSortDir(nextDir);
      writePrefs({ sortKey: key, sortDir: nextDir });
    } else {
      const nextDir = defaultSortDirection(key);
      setSortKey(key);
      setSortDir(nextDir);
      writePrefs({ sortKey: key, sortDir: nextDir });
    }
  };

  return (
    <section className="grid grid-cols-[minmax(0,1fr)_390px] max-[1100px]:grid-cols-1 gap-3 items-start">
      <WatchlistPanel
        watchlists={watchlists}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        rows={{ visible: visibleRows, total: activeList.rows.length }}
        selectedKey={effectiveSelectedKey}
        onSelectRow={setSelectedKey}
        btcPulseChip={btcPulseChip}
        btcStalenessBanner={btcStalenessBanner}
      />
      <aside className="detail-rail self-stretch">
        <div className="grid gap-3 items-start sticky top-3 max-[1100px]:static">
          <SelectedCoinRail row={selectedRow} />
        </div>
      </aside>
    </section>
  );
}
