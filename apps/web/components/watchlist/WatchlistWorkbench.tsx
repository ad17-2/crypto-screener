'use client';

import type { Watchlist, WatchlistId } from '@crypto-screener/contracts';
import { useEffect, useMemo, useState } from 'react';
import { rowKey } from '@/lib/dashboard-row';
import { readPrefs, writePrefs } from '@/lib/prefs';
import type { WatchlistFilterState } from '@/lib/watchlist-filters';
import { collectSources, DEFAULT_WATCHLIST_FILTERS, filterRows } from '@/lib/watchlist-filters';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';
import { defaultSortDirection, sortRows } from '@/lib/watchlist-sort';
import { SelectedCoinRail } from './SelectedCoinRail';
import { type Density, WatchlistPanel } from './WatchlistPanel';

export interface WatchlistWorkbenchProps {
  watchlists: Watchlist[];
}

const SORT_KEYS: readonly SortColumnKey[] = [
  'symbol',
  'setup',
  'score',
  'conf',
  'quality',
  'price',
  'oi',
  'funding',
  'ls',
  'volume',
  'source',
];

function defaultTab(watchlists: Watchlist[]): WatchlistId {
  return watchlists.some((list) => list.id === 'chart_next')
    ? 'chart_next'
    : (watchlists[0]?.id ?? 'chart_next');
}

export function WatchlistWorkbench({ watchlists }: WatchlistWorkbenchProps) {
  const [activeTab, setActiveTab] = useState<WatchlistId>(() => defaultTab(watchlists));
  const [density, setDensity] = useState<Density>('comfortable');
  const [filters, setFilters] = useState<WatchlistFilterState>(DEFAULT_WATCHLIST_FILTERS);
  const [sortKey, setSortKey] = useState<SortColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Post-mount only, matching ThemeProvider: server-safe default renders first (no hydration
  // mismatch), then this syncs from localStorage once real prefs are known.
  useEffect(() => {
    const prefs = readPrefs();
    if (prefs.density === 'compact' || prefs.density === 'comfortable') setDensity(prefs.density);
    const matchedSortKey = SORT_KEYS.find((key) => key === prefs.sortKey);
    if (matchedSortKey) setSortKey(matchedSortKey);
    if (prefs.sortDir === 'asc' || prefs.sortDir === 'desc') setSortDir(prefs.sortDir);
  }, []);

  const sourceOptions = useMemo(() => collectSources(watchlists), [watchlists]);

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

  const handleDensityChange = (next: Density) => {
    setDensity(next);
    writePrefs({ density: next });
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
        density={density}
        onDensityChange={handleDensityChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        sourceOptions={sourceOptions}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        rows={{ visible: visibleRows, total: activeList.rows.length }}
        selectedKey={effectiveSelectedKey}
        onSelectRow={setSelectedKey}
      />
      <aside className="detail-rail self-stretch">
        <div className="grid gap-3 items-start sticky top-3 max-[1100px]:static">
          <SelectedCoinRail row={selectedRow} />
        </div>
      </aside>
    </section>
  );
}
