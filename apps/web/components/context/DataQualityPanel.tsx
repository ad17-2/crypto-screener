import type { Quality } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import { QualityFlagChip } from '@/components/QualityFlagChip';
import { fmtPct } from '@/lib/format';

export interface DataQualityPanelProps {
  quality: Quality;
}

export function DataQualityPanel({ quality }: DataQualityPanelProps) {
  const flags = quality.flagged_rows;

  return (
    <Panel title="Data Quality" meta={`${quality.excluded_count} excluded`} accent="blue">
      <div className="quality-flags p-3 grid gap-2.5">
        {flags.length === 0 ? (
          <div className="quality-card grid gap-1.5 p-2 rounded-md">
            <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
              <strong>All clear</strong>
              <span>sanity checks passed</span>
            </div>
          </div>
        ) : (
          flags.map((row) => (
            <div
              key={`${row.symbol ?? 'unknown'}-${row.data_source ?? 'unknown'}`}
              className="quality-card grid gap-1.5 p-2 rounded-md"
            >
              <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
                <strong>{row.symbol ?? '-'}</strong>
                <span>
                  {fmtPct(row.price_change_24h_pct)} / OI {fmtPct(row.oi_change_24h_pct)}
                </span>
              </div>
              <div className="quality-flag-list flex flex-wrap gap-1">
                {row.flags.map((flag) => (
                  <QualityFlagChip key={flag} flag={flag} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
