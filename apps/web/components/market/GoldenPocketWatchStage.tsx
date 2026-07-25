import type { DashboardRow } from '@crypto-screener/contracts';
import { lookupTechnicalPattern } from '@/lib/copy';
import { fmtPrice, ordinal } from '@/lib/format';
import {
  formatGoldenPocketDistance,
  type RankedGoldenPocketRow,
  rankGoldenPocketWatch,
} from '@/lib/golden-pocket-watch';
import { SetupConfidenceBadge, sideMeta } from '../watchlist/WatchlistTable';

export interface GoldenPocketWatchStageProps {
  longRows: DashboardRow[];
  shortRows: DashboardRow[];
}

const MAX_ROWS = 5;

/**
 * Ranks the current watchlist by how close each coin is to its own 4h golden-pocket zone -- the
 * user enters on 1H/15M golden-pocket pullbacks, so "which candidate is nearest my trigger right
 * now" is the question this answers. Always renders (never null): an empty watchlist, or a run
 * where nothing has a clean swing leg, is itself worth surfacing, not hiding.
 */
export function GoldenPocketWatchStage({ longRows, shortRows }: GoldenPocketWatchStageProps) {
  const { ranked, total } = rankGoldenPocketWatch(longRows, shortRows);
  const top = ranked.slice(0, MAX_ROWS);

  return (
    <section className="stage" aria-label="Golden pocket watch">
      <h2 className="stage-eyebrow m-0">Golden pocket watch</h2>
      {top.length === 0 ? (
        <p className="verdict-sub mt-2">
          No watchlist coin has a clean 4h swing leg to measure a golden pocket from this run.
        </p>
      ) : (
        <ol className="mt-4 list-none p-0 m-0">
          {top.map((item, index) => (
            <GoldenPocketWatchRow
              key={`${item.row.symbol ?? '-'}:${item.row.side}`}
              item={item}
              rank={index + 1}
            />
          ))}
        </ol>
      )}
      <p className="mt-4 text-[12px] text-muted">
        {ranked.length} of {total} watchlist coins have a clean swing leg this run.
      </p>
    </section>
  );
}

function GoldenPocketWatchRow({ item, rank }: { item: RankedGoldenPocketRow; rank: number }) {
  const { row, distance, lower, upper } = item;
  const side = sideMeta(row.side);
  const pattern = lookupTechnicalPattern(row.technical_setup);
  const distanceLabel = formatGoldenPocketDistance(distance);

  return (
    <li className="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2.5 border-b border-line last:border-b-0">
      <span className="font-mono text-ash text-[11px] shrink-0">{ordinal(rank)}</span>
      <span className="font-bold text-ink text-[14px]">{row.symbol ?? '—'}</span>
      <span className={`setup-badge ${side.tone}`}>{side.label}</span>
      <span className="text-[12px] text-muted" title={pattern.definition}>
        {pattern.label}
      </span>
      {row.setup_confidence ? <SetupConfidenceBadge confidence={row.setup_confidence} /> : null}
      <div className="w-full driver-line mt-1">
        {`${fmtPrice(lower)} – ${fmtPrice(upper)} · `}
        {distance === 0 ? <span className="setup-badge pos">{distanceLabel}</span> : distanceLabel}
      </div>
    </li>
  );
}
