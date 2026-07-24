import type { DashboardRow, DashboardRowSide } from '@crypto-screener/contracts';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Term } from '@/components/ui/Tooltip';
import {
  lookupMetric,
  lookupQualityFlag,
  lookupRunTrend,
  lookupSetup,
  lookupSetupConfidence,
} from '@/lib/copy';
import {
  positioningDivergence,
  rowKey,
  runTrendTone,
  sizeMultiplierChip,
  tradingViewUrl,
} from '@/lib/dashboard-row';
import { arrowPct, clsFor, fmtNum, fmtPct, fmtUsd } from '@/lib/format';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';

export interface WatchlistTableProps {
  rows: DashboardRow[];
  sortKey: SortColumnKey | null;
  sortDir: SortDirection;
  onSort: (key: SortColumnKey) => void;
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
  emptyMessage: string;
}

interface ColumnDef {
  key: SortColumnKey;
  label: string;
  /** Present only where the term isn't self-evident -- renders via Term (label + ⓘ). */
  definition?: string;
  /** Text columns read left; numbers read right. Must match the body cell, or the header floats
      away from the data it labels. */
  align?: 'left';
}

const COLUMNS: ColumnDef[] = [
  { key: 'symbol', label: 'Coin', align: 'left' },
  { key: 'setup', label: 'Setup', align: 'left' },
  { key: 'price', label: '24h' },
  { key: 'volume', ...lookupMetric('volume') },
  { key: 'oi', label: 'OI 24h', definition: lookupMetric('open_interest').definition },
  { key: 'funding', ...lookupMetric('funding') },
  { key: 'crowding', ...lookupMetric('crowding') },
  { key: 'btc_correlation', ...lookupMetric('btc_correlation') },
  { key: 'positioning_divergence', ...lookupMetric('positioning_divergence') },
];

/**
 * 9-column desktop layout, overriding `.watch-head`/`.watch-row`'s 11-column
 * `grid-template-columns` in app/globals.css (out of scope for this change -- owned elsewhere).
 * Tailwind v4 utilities beat components in the cascade layers regardless of specificity, so this
 * arbitrary grid-cols utility wins over the component rule -- including globals.css's own
 * `@media (max-width: 900px)` 2-column override, which is why that override is repeated here too
 * (it would otherwise be shadowed the same way, breaking the mobile card collapse). No Rank or
 * Conviction column here -- THE SCREEN ranks by observable facts, not a model opinion.
 */
const GRID_COLUMNS =
  'grid-cols-[minmax(96px,1.05fr)_minmax(150px,1.5fr)_minmax(68px,0.62fr)_minmax(86px,0.8fr)_minmax(76px,0.68fr)_minmax(82px,0.74fr)_minmax(76px,0.68fr)_minmax(76px,0.68fr)_minmax(76px,0.68fr)] max-[900px]:grid-cols-2';

export interface SideMeta {
  label: string;
  tone: 'pos' | 'neg' | 'warn' | 'neutral';
}

const SIDE_META: Record<DashboardRowSide, SideMeta> = {
  long: { label: 'Long', tone: 'pos' },
  short: { label: 'Short', tone: 'neg' },
  'fade-long': { label: 'Fade', tone: 'warn' },
  'squeeze-risk': { label: 'Squeeze', tone: 'warn' },
  core: { label: 'Core', tone: 'neutral' },
};

/** Shared with SelectedCoinRail -- both need the same side -> direction-chip label/tone mapping. */
export function sideMeta(side: DashboardRowSide): SideMeta {
  return SIDE_META[side];
}

/**
 * Real `<table>`, not `<div>`s: `.watch-head`/`.watch-row` override row/cell `display` to `grid`
 * for layout, but implicit table/row/cell roles survive a `display` override, so screen readers
 * keep table navigation without explicit `role` attributes.
 */
export function WatchlistTable({
  rows,
  sortKey,
  sortDir,
  onSort,
  selectedKey,
  onSelectRow,
  emptyMessage,
}: WatchlistTableProps) {
  if (rows.length === 0) {
    return <div className="py-7 px-3 text-muted text-center">{emptyMessage}</div>;
  }

  return (
    // No `overflow-hidden` here. It clipped the column-header tooltips (the Crowding popover, being
    // the rightmost column, was sliced down to a few characters at the table's edge) and it bought
    // nothing: `.watch-table` carries no border-radius or bleed to clip. It also made the table its
    // own scrollport, which silently disabled the sticky header below -- a table that never scrolls
    // internally pins `top: 0` to its own top edge forever.
    <table aria-label="Watchlist rows" className="watch-table w-full block">
      <thead className="block">
        <tr
          className={`watch-head ${GRID_COLUMNS} sticky top-0 z-[2] px-3 py-2 border-b border-line bg-panel-2 text-ash text-xs font-medium tracking-[0.25em] uppercase`}
        >
          {COLUMNS.map((column) => (
            <HeaderCell
              key={column.key}
              columnKey={column.key}
              label={column.label}
              definition={column.definition}
              align={column.align}
              active={sortKey === column.key}
              dir={sortDir}
              onSort={onSort}
            />
          ))}
        </tr>
      </thead>
      <tbody className="block">
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <WatchlistRow
              key={key}
              row={row}
              rowKeyValue={key}
              active={key === selectedKey}
              onSelectRow={onSelectRow}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function HeaderCell({
  columnKey,
  label,
  definition,
  align,
  active,
  dir,
  onSort,
}: {
  columnKey: SortColumnKey;
  label: string;
  definition?: string | undefined;
  align?: 'left' | undefined;
  active: boolean;
  dir: SortDirection;
  onSort: (key: SortColumnKey) => void;
}) {
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : '';
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  // Alignment has to be a utility here, not a `@layer components` rule: Tailwind v4 fixes the layer
  // order (theme, base, components, utilities), so ANY utility in this className beats a component
  // rule of any specificity. globals.css used to carry a `:first-child/:nth-child(2)` left-align
  // rule for exactly this and it could never win against `justify-end`.
  const alignment = align === 'left' ? 'justify-start text-left' : 'justify-end text-right';

  // The ⓘ trigger can sit inside this clickable/keydown-handled header cell — bail out of
  // sorting when the interaction originated there, the same `.closest()` guard WatchlistRow
  // uses for its nested <a> links, rather than giving the tooltip trigger its own handlers.
  const fromTooltipTrigger = (target: EventTarget | null) =>
    target instanceof Element && target.closest('.tooltip-trigger') !== null;

  return (
    <th
      scope="col"
      tabIndex={0}
      aria-sort={ariaSort}
      onClick={(event) => {
        if (fromTooltipTrigger(event.target)) return;
        onSort(columnKey);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (fromTooltipTrigger(event.target)) return;
        event.preventDefault();
        onSort(columnKey);
      }}
      className={`watch-th inline-flex items-center ${alignment} gap-0.5 cursor-pointer select-none whitespace-nowrap hover:text-ink${active ? ' sorted text-ink' : ''}`}
    >
      {/* Opens down and inward: down because the header is the table's top edge with nothing above
          it, and inward (align="right") because every column carrying a definition is a right-aligned
          numeric one, the last of which (Crowding) sits flush against the page's right margin. */}
      {definition ? (
        <Term label={label} definition={definition} placement="bottom" align="right" />
      ) : (
        label
      )}
      <span className="sort-arrow text-[9px] leading-none transition-colors duration-100">
        {arrow}
      </span>
    </th>
  );
}

function WatchlistRow({
  row,
  rowKeyValue,
  active,
  onSelectRow,
}: {
  row: DashboardRow;
  rowKeyValue: string;
  active: boolean;
  onSelectRow: (key: string) => void;
}) {
  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && event.target.closest('a')) return;
    onSelectRow(rowKeyValue);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelectRow(rowKeyValue);
  };

  return (
    <tr
      className={`watch-row ${GRID_COLUMNS}${active ? ' active' : ''}`}
      aria-selected={active}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <SymbolCell row={row} />
      <SetupCell row={row} />
      <td className={`watch-cell ${clsFor(row.price_change_24h_pct)}`} data-label="24h">
        {arrowPct(row.price_change_24h_pct)}
      </td>
      <td className="watch-cell" data-label="Volume">
        {fmtUsd(row.quote_volume_usd)}
      </td>
      <td className={`watch-cell ${clsFor(row.oi_change_24h_pct)}`} data-label="OI 24h">
        {arrowPct(row.oi_change_24h_pct)}
      </td>
      <td className={`watch-cell ${clsFor(row.funding_rate_pct)}`} data-label="Funding">
        {fmtPct(row.funding_rate_pct, 4)}
      </td>
      <td className="watch-cell" data-label="Crowding">
        {row.long_short_ratio == null ? '-' : fmtNum(row.long_short_ratio)}
      </td>
      <td className={`watch-cell ${correlationTone(row.btc_correlation)}`} data-label="BTC corr">
        {row.btc_correlation == null ? '-' : fmtNum(row.btc_correlation, 2)}
      </td>
      <td className={`watch-cell ${positioningDivergenceTone(row)}`} data-label="Smart $">
        {row.positioning_divergence == null ? '-' : fmtNum(row.positioning_divergence, 2)}
      </td>
    </tr>
  );
}

/**
 * `clsFor` (green-up/red-down) is the wrong tone here: correlation isn't good or bad by sign, it's
 * a risk-magnitude read. High |correlation| (chained to BTC -- a BTC pump can squeeze a short even
 * against its own signal) gets the existing amber 'warn' tone; near-zero (decoupled) gets the
 * existing muted tone; the mid range is left unstyled.
 */
function correlationTone(value: number | null): string {
  if (value === null) return '';
  const magnitude = Math.abs(value);
  if (magnitude >= 0.7) return 'text-gold';
  if (magnitude <= 0.3) return 'text-muted';
  return '';
}

/** Tone for the Smart $ column. Delegates to positioningDivergence() so the column's highlight
 *  matches the SelectedCoinRail badge for the same row, instead of re-thresholding the top÷global
 *  ratio independently (which could contradict the badge). Stays uncolored when the cell shows "-"
 *  (positioning_divergence null — e.g. the crowd ratio is non-positive so top÷global is undefined). */
export function positioningDivergenceTone(
  row: Pick<
    DashboardRow,
    'long_short_account_ratio' | 'top_trader_long_short_ratio' | 'positioning_divergence'
  >,
): string {
  if (row.positioning_divergence == null) return '';
  const divergence = positioningDivergence(row);
  if (!divergence) return '';
  if (divergence.tone === 'warn') return 'text-gold';
  if (divergence.tone === 'pos') return 'text-up';
  return '';
}

/** SymbolCell renders in every tab, including the merged 'Top Setups' view, so the NEW chip's
 *  tooltip can't assume a single list context -- it reads the row's own `side` instead. */
const NEW_TO_LIST_TITLES: Partial<Record<DashboardRowSide, string>> = {
  long: "Joined the Long list at the latest run — wasn't on it in the previous run.",
  short: "Joined the Short list at the latest run — wasn't on it in the previous run.",
};

const NEW_TO_LIST_DEFAULT_TITLE =
  "Joined a watchlist at the latest run — wasn't on it in the previous run.";

function newToListTitle(side: DashboardRowSide): string {
  return NEW_TO_LIST_TITLES[side] ?? NEW_TO_LIST_DEFAULT_TITLE;
}

function SymbolCell({ row }: { row: DashboardRow }) {
  const href = tradingViewUrl(row);
  const flagged = row.data_quality_flags.length > 0 || row.is_trusted === false;
  return (
    <td className="watch-cell left watch-symbol" data-label="Coin">
      <span className="inline-flex items-center gap-1.5">
        {href !== '#' ? (
          <a
            className="symbol-link"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${row.symbol} on TradingView`}
          >
            {row.symbol || '-'}
          </a>
        ) : (
          <span className="symbol-link">{row.symbol || '-'}</span>
        )}
        {flagged ? <QualityWarningMark row={row} /> : null}
        {row.new_to_list ? (
          <span className="setup-badge warn" title={newToListTitle(row.side)}>
            NEW
          </span>
        ) : null}
        <RunTrendBadge row={row} />
      </span>
    </td>
  );
}

const RUN_TREND_CLASS: Record<'pos' | 'neg' | 'neutral', string> = {
  pos: 'setup-badge pos',
  neg: 'setup-badge neg',
  neutral: 'setup-badge neutral',
};

/** Shared with SelectedCoinRail -- same reuse pattern as sideMeta/FightsBtcChip below. Renders
 *  nothing for 'new' (see runTrendTone's own doc) or when run_trend is absent. */
export function RunTrendBadge({ row }: { row: DashboardRow }) {
  const tone = runTrendTone(row.run_trend);
  if (tone === null) return null;
  const meta = lookupRunTrend(row.run_trend);
  return (
    <span className={RUN_TREND_CLASS[tone]} title={meta.definition}>
      {meta.label}
    </span>
  );
}

function QualityWarningMark({ row }: { row: DashboardRow }) {
  const flags = row.data_quality_flags;
  const title = flags.length
    ? flags
        .map((flag) => {
          const entry = lookupQualityFlag(flag);
          return entry.detail ? `${entry.label}: ${entry.detail}` : entry.label;
        })
        .join('; ')
    : "This row didn't pass data-quality checks.";
  return (
    <span className="pos-dot warn" title={title}>
      ⚠
    </span>
  );
}

function SetupCell({ row }: { row: DashboardRow }) {
  const side = sideMeta(row.side);
  const setup = lookupSetup(row.setup);
  return (
    <td className="watch-cell left watch-setup" data-label="Setup">
      <span className={`setup-badge ${side.tone}`}>{side.label}</span>
      <span className={`setup-badge ${row.setup_tone || 'neutral'}`}>{setup.label}</span>
      {row.setup_confidence ? <SetupConfidenceBadge confidence={row.setup_confidence} /> : null}
      {row.fights_btc ? <FightsBtcChip /> : null}
      <SizeChip row={row} />
    </td>
  );
}

/** size_multiplier is volatility-derived SIZING, never conviction -- 'Low vol'/'High vol' describe
 *  how calm the coin's own ATR is, not how much the screen likes the setup. Renders nothing for the
 *  common near-neutral case (see sizeMultiplierChip's own doc). */
function SizeChip({ row }: { row: DashboardRow }) {
  const chip = sizeMultiplierChip(row);
  if (chip === null) return null;
  return (
    <span className={`setup-badge ${chip.tone}`} title={chip.title}>
      {chip.label}
    </span>
  );
}

/** A/B/C = how many of setupConfidence()'s directional votes agreed (apps/api/src/dashboard/rows.ts).
 *  A gets the same 'pos' tone as an aligned verdict; C is deliberately duller than the default
 *  badge look (`text-muted`, a Tailwind utility, beats `.setup-badge`'s own color in the cascade --
 *  see GRID_COLUMNS's comment above for why utilities always win here) so a C-grade setup doesn't
 *  visually compete with the badges next to it. */
const SETUP_CONFIDENCE_CLASS: Record<'A' | 'B' | 'C', string> = {
  A: 'setup-badge pos',
  B: 'setup-badge neutral',
  C: 'setup-badge neutral text-muted',
};

/** Shared with SelectedCoinRail -- same reuse pattern as `sideMeta`/`FightsBtcChip` above. */
export function SetupConfidenceBadge({ confidence }: { confidence: 'A' | 'B' | 'C' }) {
  const meta = lookupSetupConfidence(confidence);
  return (
    <span className={SETUP_CONFIDENCE_CLASS[confidence]} title={meta.definition}>
      [{meta.label}]
    </span>
  );
}

/**
 * The classic fakeout flag: this row's direction is opposed by a live BTC impulse it's
 * historically correlated to. Shared with SelectedCoinRail (same reuse pattern as `sideMeta`
 * above) so the same chip, wording, and definition appear in both places.
 */
export function FightsBtcChip() {
  return (
    <span className="setup-badge warn" title={lookupMetric('fights_btc').definition}>
      Fights BTC
    </span>
  );
}
