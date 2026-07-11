import type { DashboardRow } from '@crypto-screener/contracts';
import { InfoTip } from '@/components/ui/Tooltip';
import { lookupMetric, lookupSetup } from '@/lib/copy';
import { arrowPct, clsFor, fmtPct } from '@/lib/format';

export interface CoreReadStageProps {
  rows: DashboardRow[];
}

/**
 * BTC / ETH / SOL, promoted out of the coin tabs -- they're market context, not screening
 * candidates. Renders nothing when there are no core rows.
 */
export function CoreReadStage({ rows }: CoreReadStageProps) {
  if (rows.length === 0) return null;

  return (
    <section className="stage" aria-label="The majors">
      <h2 className="stage-eyebrow m-0">The majors</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <CoreCard key={`${row.symbol ?? '-'}:${row.side}`} row={row} />
        ))}
      </div>
    </section>
  );
}

function CoreCard({ row }: { row: DashboardRow }) {
  const setup = lookupSetup(row.setup);
  const confluence = row.confluence;

  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-ink">{row.symbol ?? '—'}</h3>
        <span className={`font-mono text-[13px] ${clsFor(row.price_change_24h_pct)}`}>
          {fmtPct(row.price_change_24h_pct)}
        </span>
      </div>
      <div className="mt-1 font-mono text-[19px] font-medium">{formatPrice(row.price_usd)}</div>
      <span className={`setup-badge mt-2 ${row.setup_tone || 'neutral'}`}>{setup.label}</span>
      <p className="mt-2 text-[12px] text-muted">
        {confluence.total > 0
          ? `${confluence.aligned} of ${confluence.total} signal groups agree ${confluence.direction}.`
          : 'No confluence read.'}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MiniStat
          label="Funding"
          value={fmtPct(row.funding_rate_pct, 4)}
          toneClass={clsFor(row.funding_rate_pct)}
          metricKey="funding"
        />
        <MiniStat
          label="OI 24h"
          value={arrowPct(row.oi_change_24h_pct)}
          toneClass={clsFor(row.oi_change_24h_pct)}
          metricKey="open_interest"
        />
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  toneClass,
  metricKey,
}: {
  label: string;
  value: string;
  toneClass: string;
  metricKey: string;
}) {
  return (
    <div>
      <span className="stat-label inline-flex items-center gap-1">
        {label}
        <InfoTip term={label} definition={lookupMetric(metricKey).definition} />
      </span>
      <div className={`stat-value text-[14px] ${toneClass}`}>{value}</div>
    </div>
  );
}

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
