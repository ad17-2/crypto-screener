import type { Quality, Watchlist } from '@crypto-screener/contracts';
import { InfoTip } from '@/components/ui/Tooltip';
import { lookupBias, lookupMetric, lookupRegimeState } from '@/lib/copy';
import { num, pct, signedPct, str } from '@/lib/payload';
import { marketVerdict, sieveStages } from '@/lib/verdict';
import { Sieve } from './Sieve';

export interface MarketStageProps {
  /** untyped on the wire — read defensively. */
  regime: unknown;
  /** untyped on the wire — read defensively. */
  marketContext: unknown;
  /** untyped on the wire — read defensively. */
  validation: unknown;
  quality: Quality;
  /** untyped on the wire — read defensively. */
  providerStatus: unknown;
  run: { row_count: number };
  watchlists: Watchlist[];
}

/**
 * The hero: a plain-English market verdict, the sieve funnel (real pipeline counts), and the
 * stat tiles. Server Component -- only the sieve's final segment needs a client boundary, and
 * that's isolated inside <Sieve>.
 */
export function MarketStage({
  regime,
  marketContext,
  validation,
  quality,
  providerStatus,
  run,
  watchlists,
}: MarketStageProps) {
  const verdict = marketVerdict({ regime, market_context: marketContext, validation, quality });
  const stages = sieveStages({ provider_status: providerStatus, run, quality, watchlists });

  // Mirrors verdict.ts's own headlineFor() precedence (regime_state, falling back to the legacy
  // label field) so the Regime tile always reads the same state the headline above was built from.
  const regimeState = str(regime, 'regime_state') ?? str(regime, 'label');
  const marketCapChange = num(marketContext, 'market_cap_change_24h_pct');

  return (
    <section className="stage" aria-label="The market">
      <h2 className="stage-eyebrow m-0">The market</h2>
      <h3 className="verdict m-0 mt-2">{verdict.headline}</h3>
      <p className="verdict-sub">{verdict.summary}</p>
      {verdict.facts.length > 0 ? (
        <ul className="mt-4 grid max-w-[62ch] list-none gap-1.5 p-0 text-[13px] text-muted">
          {verdict.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-10">
        <Sieve stages={stages} />
      </div>

      <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Regime" value={lookupRegimeState(regimeState).label} metricKey="regime" />
        <StatTile label="Bias" value={lookupBias(str(regime, 'bias')).label} metricKey="bias" />
        <StatTile
          label="Market cap 24h"
          value={signedPct(marketCapChange, 2)}
          metricKey="change_24h"
          tone={
            marketCapChange === null
              ? undefined
              : marketCapChange > 0
                ? 'pos'
                : marketCapChange < 0
                  ? 'neg'
                  : undefined
          }
        />
        <StatTile
          label="BTC dominance"
          value={pct(num(marketContext, 'btc_dominance_pct'), 2)}
          metricKey="btc_dominance"
        />
        <StatTile
          label="ETH dominance"
          value={pct(num(marketContext, 'eth_dominance_pct'), 2)}
          metricKey="eth_dominance"
        />
        <StatTile
          label="Volatility"
          value={pct(num(marketContext, 'median_atr_pct'), 2)}
          metricKey="volatility"
        />
      </div>

      <p className="mt-3 text-[12px] text-muted">
        {quality.trusted_count} coin{quality.trusted_count === 1 ? '' : 's'} trusted for scoring
        {quality.excluded_count > 0 ? `, ${quality.excluded_count} excluded for data quality` : ''}.
      </p>
    </section>
  );
}

function StatTile({
  label,
  value,
  tone,
  metricKey,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg' | 'warn' | undefined;
  metricKey?: string;
}) {
  const metric = metricKey ? lookupMetric(metricKey) : null;
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <span className="stat-label inline-flex items-center gap-1">
        {label}
        {metric ? <InfoTip term={label} definition={metric.definition} /> : null}
      </span>
      <div className="stat-value">{value}</div>
    </div>
  );
}
