import type { DashboardRow, Watchlist, WatchlistId } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import type { WatchlistFilterState } from '@/lib/watchlist-filters';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';
import { WatchlistTable } from './WatchlistTable';

export type Density = 'comfortable' | 'compact';

export interface WatchlistPanelRows {
  visible: DashboardRow[];
  total: number;
}

export interface WatchlistPanelProps {
  watchlists: Watchlist[];
  activeTab: WatchlistId;
  onTabChange: (id: WatchlistId) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  filters: WatchlistFilterState;
  onFiltersChange: (patch: Partial<WatchlistFilterState>) => void;
  sourceOptions: string[];
  sortKey: SortColumnKey | null;
  sortDir: SortDirection;
  onSort: (key: SortColumnKey) => void;
  rows: WatchlistPanelRows;
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
}

/** Fully controlled by WatchlistWorkbench (shared with SelectedCoinRail) — no local state here. */
export function WatchlistPanel({
  watchlists,
  activeTab,
  onTabChange,
  density,
  onDensityChange,
  filters,
  onFiltersChange,
  sourceOptions,
  sortKey,
  sortDir,
  onSort,
  rows,
  selectedKey,
  onSelectRow,
}: WatchlistPanelProps) {
  return (
    <Panel
      title="Watchlist"
      meta={
        <div className="inline-flex items-center gap-2">
          <button
            type="button"
            aria-label="Toggle row density"
            onClick={() => onDensityChange(density === 'compact' ? 'comfortable' : 'compact')}
            className="density-btn h-[26px] px-2 rounded-full border border-line bg-panel text-muted text-[11px] font-bold tracking-wide uppercase cursor-pointer"
          >
            {density === 'compact' ? 'Compact' : 'Comfortable'}
          </button>
          <span className="text-muted text-xs font-mono tabular-nums">
            {rows.visible.length} / {rows.total}
          </span>
        </div>
      }
      aria-label="Watchlist workbench"
      className="overflow-visible"
    >
      <div className="flex gap-1.5 flex-wrap px-3 pt-2.5">
        {watchlists.map((list) => (
          // Tailwind v4 cascade layers put utilities above components regardless of specificity —
          // these border/bg/text utilities must stay conditional or they'd erase .active's look.
          <button
            key={list.id}
            type="button"
            onClick={() => onTabChange(list.id)}
            className={`tab-btn h-[30px] rounded-full px-3 border text-xs font-semibold cursor-pointer${
              list.id === activeTab ? ' active' : ' border-line bg-panel-2 text-muted'
            }`}
          >
            {list.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 items-center flex-wrap px-3 py-2.5 border-b border-line bg-panel">
        <input
          className="h-8 min-w-[180px] max-[680px]:w-full border border-line rounded-md bg-panel text-ink px-2 text-xs"
          type="search"
          placeholder="Filter symbol or setup"
          aria-label="Filter symbol or setup"
          value={filters.query}
          onChange={(event) => onFiltersChange({ query: event.target.value })}
        />
        <select
          className="h-8 min-w-[132px] max-[680px]:w-full border border-line rounded-md bg-panel text-ink px-2 text-xs"
          aria-label="Minimum quality"
          value={filters.quality}
          onChange={(event) => onFiltersChange({ quality: Number(event.target.value) })}
        >
          <option value={0}>Q 0+</option>
          <option value={50}>Q 50+</option>
          <option value={75}>Q 75+</option>
          <option value={90}>Q 90+</option>
        </select>
        <select
          className="h-8 min-w-[132px] max-[680px]:w-full border border-line rounded-md bg-panel text-ink px-2 text-xs"
          aria-label="Source"
          value={filters.source}
          onChange={(event) => onFiltersChange({ source: event.target.value })}
        >
          <option value="all">All sources</option>
          {sourceOptions.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
        <select
          className="h-8 min-w-[132px] max-[680px]:w-full border border-line rounded-md bg-panel text-ink px-2 text-xs"
          aria-label="Minimum volume"
          value={filters.volume}
          onChange={(event) => onFiltersChange({ volume: Number(event.target.value) })}
        >
          <option value={0}>Any volume</option>
          <option value={20000000}>$20M+</option>
          <option value={100000000}>$100M+</option>
          <option value={1000000000}>$1B+</option>
        </select>
        <label className="filter-toggle inline-flex items-center gap-1.5 h-8 px-2 border border-line rounded-md text-ink bg-panel text-xs whitespace-nowrap max-[680px]:w-full">
          <input
            type="checkbox"
            checked={filters.positiveOi}
            onChange={(event) => onFiltersChange({ positiveOi: event.target.checked })}
          />{' '}
          OI &gt; 0
        </label>
        <label className="filter-toggle inline-flex items-center gap-1.5 h-8 px-2 border border-line rounded-md text-ink bg-panel text-xs whitespace-nowrap max-[680px]:w-full">
          <input
            type="checkbox"
            checked={filters.negativeFunding}
            onChange={(event) => onFiltersChange({ negativeFunding: event.target.checked })}
          />{' '}
          Funding &lt; 0
        </label>
      </div>
      <WatchlistTable
        rows={rows.visible}
        density={density}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        selectedKey={selectedKey}
        onSelectRow={onSelectRow}
      />
    </Panel>
  );
}
