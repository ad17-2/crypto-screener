import type { DashboardRow, Watchlist, WatchlistId } from '@crypto-screener/contracts';
import type { ReactNode } from 'react';
import { Panel } from '@/components/layout/Panel';
import { Term } from '@/components/ui/Tooltip';
import { lookupMetric, lookupWatchlist } from '@/lib/copy';
import { fmtPct } from '@/lib/format';
import { num } from '@/lib/payload';
import type { WatchlistFilterState } from '@/lib/watchlist-filters';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';
import { WatchlistTable } from './WatchlistTable';

export interface WatchlistPanelRows {
  visible: DashboardRow[];
  total: number;
}

export interface WatchlistPanelProps {
  watchlists: Watchlist[];
  activeTab: WatchlistId;
  onTabChange: (id: WatchlistId) => void;
  filters: WatchlistFilterState;
  onFiltersChange: (patch: Partial<WatchlistFilterState>) => void;
  sortKey: SortColumnKey | null;
  sortDir: SortDirection;
  onSort: (key: SortColumnKey) => void;
  rows: WatchlistPanelRows;
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
  /** untyped on the wire -- read defensively; carries net_directional_return_pct. */
  validation: unknown;
}

// Ranked setups vs "crowding risk" fade/squeeze candidates -- two intents, not one flat list.
// Not labeled "worth trading": the model's net edge after costs is currently negative (see the Net edge note below).
const SHORTLIST_IDS: readonly WatchlistId[] = ['chart_next', 'regime_fit', 'long', 'short'];
const CROWDING_RISK_IDS: readonly WatchlistId[] = ['crowded_longs', 'squeeze_risks'];

const EMPTY_WATCHLIST_MESSAGE: Record<WatchlistId, string> = {
  chart_next: 'No standout setups right now.',
  regime_fit: "Nothing fits today's regime right now.",
  long: 'No long candidates right now.',
  short: 'No short candidates right now.',
  crowded_longs: 'Nothing is crowded long right now.',
  squeeze_risks: 'No squeeze risk right now.',
  // Unreachable -- the core list is filtered out before it reaches this panel; mapped for type completeness.
  core: 'No majors to show.',
};

function emptyStateMessage(watchlistId: WatchlistId, hasQuery: boolean, totalRows: number): string {
  if (totalRows === 0) return EMPTY_WATCHLIST_MESSAGE[watchlistId];
  if (hasQuery) return 'No coins match your search.';
  return 'Nothing to show.';
}

/** Fully controlled by WatchlistWorkbench (shared with SelectedCoinRail) — no local state here. */
export function WatchlistPanel({
  watchlists,
  activeTab,
  onTabChange,
  filters,
  onFiltersChange,
  sortKey,
  sortDir,
  onSort,
  rows,
  selectedKey,
  onSelectRow,
  validation,
}: WatchlistPanelProps) {
  const shortlist = watchlists.filter((list) => SHORTLIST_IDS.includes(list.id));
  const crowdingRisk = watchlists.filter((list) => CROWDING_RISK_IDS.includes(list.id));
  const netEdge = num(validation, 'net_directional_return_pct');

  return (
    <Panel
      title="Watchlist"
      meta={
        <span className="text-muted text-xs font-mono tabular-nums">
          {rows.visible.length} / {rows.total}
        </span>
      }
      aria-label="Watchlist workbench"
      className="overflow-visible"
    >
      <div className="grid gap-2 px-3 pt-2.5">
        <TabGroup
          label="Shortlist"
          meta={netEdge === null ? null : <NetEdgeNote value={netEdge} />}
          lists={shortlist}
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
        <TabGroup
          label="Crowding risk"
          lists={crowdingRisk}
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
      </div>
      <div className="flex gap-2 items-center flex-wrap px-3 py-2.5 border-b border-line bg-panel">
        <input
          className="h-8 min-w-[180px] max-[680px]:w-full border border-line rounded-md bg-panel text-ink px-2 text-xs"
          type="search"
          placeholder="Find a coin"
          aria-label="Find a coin"
          value={filters.query}
          onChange={(event) => onFiltersChange({ query: event.target.value })}
        />
      </div>
      <WatchlistTable
        rows={rows.visible}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        selectedKey={selectedKey}
        onSelectRow={onSelectRow}
        emptyMessage={emptyStateMessage(activeTab, filters.query.trim().length > 0, rows.total)}
      />
    </Panel>
  );
}

function TabGroup({
  label,
  meta,
  lists,
  activeTab,
  onTabChange,
}: {
  label: string;
  meta?: ReactNode;
  lists: Watchlist[];
  activeTab: WatchlistId;
  onTabChange: (id: WatchlistId) => void;
}) {
  if (!lists.length) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="label">{label}</div>
        {meta}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {lists.map((list) => (
          // Tailwind v4 cascade layers put utilities above components regardless of specificity —
          // these border/bg/text utilities must stay conditional or they'd erase .active's look.
          <button
            key={list.id}
            type="button"
            onClick={() => onTabChange(list.id)}
            className={`tab-btn h-[30px] rounded-full px-3 border text-xs cursor-pointer${
              list.id === activeTab
                ? ' active font-bold'
                : ' border-line bg-panel-2 text-muted font-semibold'
            }`}
          >
            {lookupWatchlist(list.id).label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NetEdgeNote({ value }: { value: number }) {
  const meta = lookupMetric('net_edge');
  return (
    <span className={`text-xs font-mono tabular-nums${value < 0 ? ' text-down' : ''}`}>
      <Term label={`Net edge ${fmtPct(value, 2)}`} definition={meta.definition} />
    </span>
  );
}
