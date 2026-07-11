import type { DashboardRow } from '@crypto-screener/contracts';
import type { KeyboardEvent, MouseEvent } from 'react';
import {
  positioningDivergence,
  rowKey,
  setupConflictMeta,
  sourceParts,
  tradingViewUrl,
} from '@/lib/dashboard-row';
import {
  arrowPct,
  clsFor,
  confluenceToneClass,
  fmtNum,
  fmtPct,
  fmtUsd,
  numeric,
  qualityTone,
} from '@/lib/format';
import type { SortColumnKey, SortDirection } from '@/lib/watchlist-sort';

export interface WatchlistTableProps {
  rows: DashboardRow[];
  density: 'comfortable' | 'compact';
  sortKey: SortColumnKey | null;
  sortDir: SortDirection;
  onSort: (key: SortColumnKey) => void;
  selectedKey: string | null;
  onSelectRow: (key: string) => void;
}

const COLUMNS: Array<{ key: SortColumnKey; label: string }> = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'setup', label: 'Setup' },
  { key: 'score', label: 'Score' },
  { key: 'conf', label: 'Conf' },
  { key: 'quality', label: 'Q' },
  { key: 'price', label: '24h' },
  { key: 'oi', label: 'OI 24h' },
  { key: 'funding', label: 'Funding' },
  { key: 'ls', label: 'L/S' },
  { key: 'volume', label: 'Volume' },
  { key: 'source', label: 'Source' },
];

/**
 * Real `<table>`, not `<div>`s: `.watch-head`/`.watch-row` override row/cell `display` to `grid`
 * for layout, but implicit table/row/cell roles survive a `display` override, so screen readers
 * keep table navigation without explicit `role` attributes.
 */
export function WatchlistTable({
  rows,
  density,
  sortKey,
  sortDir,
  onSort,
  selectedKey,
  onSelectRow,
}: WatchlistTableProps) {
  if (rows.length === 0) {
    return (
      <div className="py-7 px-3 text-muted text-center">No rows match the current filters</div>
    );
  }

  const maxScore = Math.max(...rows.map((row) => Math.abs(numeric(row.score) ?? 0)), 1);

  return (
    <table
      aria-label="Watchlist rows"
      className="watch-table w-full overflow-hidden block"
      data-density={density}
    >
      <thead className="block">
        <tr className="watch-head sticky top-0 z-[2] px-3 py-2 border-b border-line bg-panel-2 text-muted text-[11px] font-bold tracking-wide uppercase text-right">
          {COLUMNS.map((column) => (
            <HeaderCell
              key={column.key}
              columnKey={column.key}
              label={column.label}
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
              maxScore={maxScore}
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
  active,
  dir,
  onSort,
}: {
  columnKey: SortColumnKey;
  label: string;
  active: boolean;
  dir: SortDirection;
  onSort: (key: SortColumnKey) => void;
}) {
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : '';
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <th
      scope="col"
      tabIndex={0}
      aria-sort={ariaSort}
      onClick={() => onSort(columnKey)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSort(columnKey);
      }}
      className={`watch-th inline-flex items-center justify-end gap-0.5 cursor-pointer select-none whitespace-nowrap hover:text-ink${active ? ' sorted text-gold' : ''}`}
    >
      {label}
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
  maxScore,
  onSelectRow,
}: {
  row: DashboardRow;
  rowKeyValue: string;
  active: boolean;
  maxScore: number;
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
      className={`watch-row${active ? ' active' : ''}`}
      aria-selected={active}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <SymbolCell row={row} />
      <SetupCell row={row} />
      <ScoreCell row={row} maxScore={maxScore} />
      <ConfluenceCell row={row} />
      <td className="watch-cell" data-label="Q">
        <span className={`quality-badge ${qualityTone(row.quality)}`}>{row.quality ?? '-'}</span>
      </td>
      <td className={`watch-cell ${clsFor(row.price_change_24h_pct)}`} data-label="24h">
        {arrowPct(row.price_change_24h_pct)}
      </td>
      <td className={`watch-cell ${clsFor(row.oi_change_24h_pct)}`} data-label="OI 24h">
        {arrowPct(row.oi_change_24h_pct)}
      </td>
      <td className={`watch-cell ${clsFor(row.funding_rate_pct)}`} data-label="Funding">
        {fmtPct(row.funding_rate_pct, 4)}
      </td>
      <PositioningCell row={row} />
      <td className="watch-cell" data-label="Volume">
        {fmtUsd(row.quote_volume_usd)}
      </td>
      <td className="watch-cell" data-label="Source">
        <div className="source-stack">
          {sourceParts(row.data_source).map((part) => (
            <span key={part} className="source-tag">
              {part}
            </span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function SymbolCell({ row }: { row: DashboardRow }) {
  const href = tradingViewUrl(row);
  const driverLine = row.primary_driver?.label || row.side || '-';
  return (
    <td className="watch-cell left watch-symbol" data-label="Symbol">
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
        row.symbol || '-'
      )}
      <span className="driver-line">{driverLine}</span>
    </td>
  );
}

function SetupCell({ row }: { row: DashboardRow }) {
  const conflictMeta = setupConflictMeta(row);
  return (
    <td className="watch-cell left watch-setup" data-label="Setup">
      <span className={`setup-badge ${row.setup_tone || 'neutral'}`}>
        {row.setup || 'Watchlist'}
      </span>
      {conflictMeta ? <span className="driver-line">{conflictMeta}</span> : null}
    </td>
  );
}

function ScoreCell({ row, maxScore }: { row: DashboardRow; maxScore: number }) {
  const score = numeric(row.score);
  const width =
    maxScore > 0 && score !== null ? Math.round(Math.min(Math.abs(score) / maxScore, 1) * 100) : 0;
  const confidence = row.confidence_score == null ? '' : ` / C ${fmtNum(row.confidence_score, 0)}`;
  return (
    <td className="watch-cell" data-label="Score">
      <span className="score-val">{fmtNum(row.score)}</span>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${width}%` }} />
      </span>
      <div className="driver-line">
        P {fmtNum(row.priority)}
        {confidence}
      </div>
    </td>
  );
}

function ConfluenceCell({ row }: { row: DashboardRow }) {
  const conf = row.confluence;
  if (!conf.families.length) {
    return (
      <td className="watch-cell" data-label="Conf">
        -
      </td>
    );
  }
  const title = `${conf.aligned} align / ${conf.against} against / ${conf.neutral} neutral (${conf.direction})`;
  return (
    <td className="watch-cell conf-cell" data-label="Conf" title={title}>
      <span className="conf-count">
        {conf.aligned}/{conf.total}
      </span>
      <span className="conf-bar">
        {conf.families.map((family) => (
          <span
            key={family.key}
            className={`conf-seg ${confluenceToneClass(family.tone)}`}
            title={`${family.label}${family.value == null ? '' : `: ${family.value}`}`}
          />
        ))}
      </span>
    </td>
  );
}

function PositioningCell({ row }: { row: DashboardRow }) {
  const divergence = positioningDivergence(row);
  const value = row.positioning_ratio == null ? '-' : fmtNum(row.positioning_ratio);
  return (
    <td className="watch-cell" data-label="L/S" title={divergence?.title}>
      {value}
      {divergence?.mark ? (
        <span className={`pos-dot ${divergence.tone}`} title={divergence.title}>
          {divergence.mark}
        </span>
      ) : null}
    </td>
  );
}
