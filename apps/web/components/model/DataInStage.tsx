import type { Freshness, Quality } from '@crypto-screener/contracts';
import { QualityFlagChip } from '@/components/QualityFlagChip';
import { lookupProvider } from '@/lib/copy';
import { num, str } from '@/lib/payload';
import { asRecord } from '@/lib/wire';

export interface DataInStageProps {
  /** untyped on the wire — read defensively. */
  providerStatus: unknown;
  quality: Quality;
  freshness: Freshness;
  run: { row_count: number };
}

interface ProviderRow {
  name: string;
  status: string;
  rows: number | null;
}

function providerRows(providerStatus: unknown): ProviderRow[] {
  return Object.entries(asRecord(providerStatus)).map(([name, raw]) => ({
    name,
    status: str(raw, 'status') ?? 'unknown',
    rows: num(raw, 'rows'),
  }));
}

function formatAge(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return 'unknown';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Stage 1: "What went in" -- is the data clean? Simplified down to tiles + a short two-column list.
 */
export function DataInStage({ providerStatus, quality, freshness, run }: DataInStageProps) {
  const providers = providerRows(providerStatus);
  const okCount = providers.filter((p) => p.status === 'ok').length;

  return (
    <section className="stage" aria-label="What went in">
      <p className="stage-eyebrow m-0">What went in</p>
      <h3 className="stage-title mt-2 mb-1">Is the data clean?</h3>
      <p className="text-muted text-[13px] max-w-[62ch]">
        Every coin is checked before it reaches the model. Rows that fail a sanity check are
        excluded from scoring, not deleted — they still show up here so nothing is hidden.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="stat">
          <span className="stat-label">Coins pulled</span>
          <div className="stat-value">{run.row_count}</div>
        </div>
        <div className="stat">
          <span className="stat-label">Trusted</span>
          <div className="stat-value">{quality.trusted_count}</div>
        </div>
        <div className={`stat${quality.excluded_count > 0 ? ' warn' : ''}`}>
          <span className="stat-label">Excluded</span>
          <div className="stat-value">{quality.excluded_count}</div>
        </div>
        <div className="stat">
          <span className="stat-label">Data age</span>
          <div className="stat-value">{formatAge(freshness.age_minutes)}</div>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <div>
          <div className="label">
            Data sources ({okCount} of {providers.length} ok)
          </div>
          <div className="list mt-2 grid gap-2">
            {providers.length === 0 ? (
              <p className="text-muted text-[13px] mt-1">No provider data for this run.</p>
            ) : (
              providers.map((provider) => (
                <div
                  key={provider.name}
                  className="list-row flex justify-between gap-3 text-[13px]"
                >
                  <strong
                    className="min-w-0 [overflow-wrap:anywhere]"
                    title={lookupProvider(provider.name).definition}
                  >
                    {lookupProvider(provider.name).label}
                  </strong>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`status-pill ${provider.status === 'ok' ? 'neutral' : 'warn'}`}
                    >
                      {provider.status}
                    </span>
                    {provider.rows !== null ? <span>{provider.rows} rows</span> : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="label">Flagged rows</div>
          <div className="mt-2 grid gap-2.5">
            {quality.flagged_rows.length === 0 ? (
              <div className="quality-card grid gap-1.5 p-2 rounded-md">
                <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
                  <strong>All clear</strong>
                  <span>Every coin passed every sanity check.</span>
                </div>
              </div>
            ) : (
              quality.flagged_rows.map((row) => (
                <div
                  key={`${row.symbol ?? 'unknown'}-${row.data_source ?? 'unknown'}`}
                  className="quality-card grid gap-1.5 p-2 rounded-md"
                >
                  <div className="quality-card-head flex justify-between gap-2 items-baseline text-[13px]">
                    <strong>{row.symbol ?? '-'}</strong>
                    <span>excluded from scoring</span>
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
        </div>
      </div>
    </section>
  );
}
