import type { DashboardRow, DashboardRowSide } from '@crypto-screener/contracts';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Term } from '@/components/ui/Tooltip';
import { lookupMetric, lookupQualityFlag, lookupSetup } from '@/lib/copy';
import { rowKey, tradingViewUrl } from '@/lib/dashboard-row';
import { arrowPct, clsFor, confluenceToneClass, fmtNum, fmtPct } from '@/lib/format';
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
}

const COLUMNS: ColumnDef[] = [
  { key: 'symbol', label: 'Coin' },
  { key: 'setup', label: 'Setup' },
  { key: 'rank', ...lookupMetric('priority') },
  { key: 'conviction', ...lookupMetric('conviction') },
  { key: 'price', label: '24h' },
  { key: 'oi', label: 'OI 24h', definition: lookupMetric('open_interest').definition },
  { key: 'funding', ...lookupMetric('funding') },
  { key: 'crowding', ...lookupMetric('crowding') },
];

/**
 * 8-column desktop layout, overriding `.watch-head`/`.watch-row`'s 11-column
 * `grid-template-columns` in app/globals.css (out of scope for this change -- owned elsewhere).
 * Tailwind v4 utilities beat components in the cascade layers regardless of specificity, so this
 * arbitrary grid-cols utility wins over the component rule -- including globals.css's own
 * `@media (max-width: 900px)` 2-column override, which is why that override is repeated here too
 * (it would otherwise be shadowed the same way, breaking the mobile card collapse).
 */
const GRID_COLUMNS =
  'grid-cols-[minmax(96px,1.05fr)_minmax(150px,1.5fr)_minmax(80px,0.7fr)_minmax(84px,0.76fr)_minmax(64px,0.58fr)_minmax(72px,0.64fr)_minmax(78px,0.7fr)_minmax(72px,0.64fr)] max-[900px]:grid-cols-2';

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

  const maxPriority = Math.max(...rows.map((row) => row.priority), 1);

  return (
    <table aria-label="Watchlist rows" className="watch-table w-full overflow-hidden block">
      <thead className="block">
        <tr
          className={`watch-head ${GRID_COLUMNS} sticky top-0 z-[2] px-3 py-2 border-b border-line bg-panel-2 text-muted text-[11px] font-bold tracking-wide uppercase text-right`}
        >
          {COLUMNS.map((column) => (
            <HeaderCell
              key={column.key}
              columnKey={column.key}
              label={column.label}
              definition={column.definition}
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
              maxPriority={maxPriority}
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
  active,
  dir,
  onSort,
}: {
  columnKey: SortColumnKey;
  label: string;
  definition?: string | undefined;
  active: boolean;
  dir: SortDirection;
  onSort: (key: SortColumnKey) => void;
}) {
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : '';
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';

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
      className={`watch-th inline-flex items-center justify-end gap-0.5 cursor-pointer select-none whitespace-nowrap hover:text-ink${active ? ' sorted text-gold' : ''}`}
    >
      {/* placement="bottom": .watch-table sets overflow:hidden, so a tooltip opening upward from
          this sticky header row is clipped out of existence. */}
      {definition ? <Term label={label} definition={definition} placement="bottom" /> : label}
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
  maxPriority,
  onSelectRow,
}: {
  row: DashboardRow;
  rowKeyValue: string;
  active: boolean;
  maxPriority: number;
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
      <RankCell row={row} maxPriority={maxPriority} />
      <ConvictionCell row={row} />
      <td className={`watch-cell ${clsFor(row.price_change_24h_pct)}`} data-label="24h">
        {arrowPct(row.price_change_24h_pct)}
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
    </tr>
  );
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
      </span>
    </td>
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
    </td>
  );
}

function RankCell({ row, maxPriority }: { row: DashboardRow; maxPriority: number }) {
  const width = maxPriority > 0 ? Math.round(Math.min(row.priority / maxPriority, 1) * 100) : 0;
  return (
    <td className="watch-cell" data-label="Rank">
      <span className="score-val">{fmtNum(row.priority)}</span>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${width}%` }} />
      </span>
    </td>
  );
}

function ConvictionCell({ row }: { row: DashboardRow }) {
  const conf = row.confluence;
  return (
    <td className="watch-cell conf-cell" data-label="Conviction">
      <span className="score-val">
        {row.confidence_score == null ? '-' : fmtNum(row.confidence_score, 0)}
      </span>
      {conf.families.length > 0 ? (
        <>
          <span className="driver-line">
            {conf.aligned}/{conf.total} agree
          </span>
          <span
            className="conf-bar"
            title={`${conf.aligned} align / ${conf.against} against / ${conf.neutral} neutral (${conf.direction})`}
          >
            {conf.families.map((family) => (
              <span key={family.key} className={`conf-seg ${confluenceToneClass(family.tone)}`} />
            ))}
          </span>
        </>
      ) : null}
    </td>
  );
}
