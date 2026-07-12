import type { Watchlist } from '@crypto-screener/contracts';
import { Term } from '@/components/ui/Tooltip';
import { sideMeta } from '@/components/watchlist/WatchlistTable';
import { lookupEdgeVerdict, lookupFactor, lookupMetric } from '@/lib/copy';
import { fmtNum, fmtPct } from '@/lib/format';
import { oneBetEvidence } from '@/lib/one-bet';

export interface OneBetStageProps {
  /** untyped on the wire -- read defensively, same convention as /model's stages. */
  modelWeights: unknown;
  watchlists: Watchlist[];
}

/**
 * Layer 3: THE ONE BET. reversal_3d is mean reversion -- a coin that fell hard over the last 3
 * days tends to bounce -- so it will often point the opposite way from the trend on the chart.
 * That is the strategy working as designed, not a contradiction with the screen above it.
 */
export function OneBetStage({ modelWeights, watchlists }: OneBetStageProps) {
  const evidence = oneBetEvidence(modelWeights);
  const factor = lookupFactor('reversal_3d');

  if (evidence === null || !evidence.validated) {
    return (
      <section className="stage" aria-label="The one bet">
        <p className="stage-eyebrow m-0">The one bet</p>
        <h3 className="stage-title mt-2 mb-1">No validated edge right now</h3>
        <p className="text-muted text-[13px] max-w-[62ch]">
          <Term label={factor.label} definition={factor.definition} /> is the only factor that has
          ever forward-validated for this model, and it is not validated on the current data. There
          is no active bet right now — treat the screen above as names to research, not a signal to
          trade.
        </p>
      </section>
    );
  }

  const candidates = (watchlists.find((list) => list.id === 'chart_next')?.rows ?? []).filter(
    (row) => row.side !== 'core',
  );
  const verdict = lookupEdgeVerdict(evidence.edgeVerdict);

  return (
    <section className="stage" aria-label="The one bet">
      <p className="stage-eyebrow m-0">The one bet</p>
      <h3 className="stage-title mt-2 mb-1 flex items-center gap-2 flex-wrap">
        <Term label={factor.label} definition={factor.definition} /> — the only validated signal
        <span className="status-pill pos" title={verdict.definition}>
          {verdict.label}
        </span>
      </h3>
      <p className="text-muted text-[13px] max-w-[64ch]">
        This is mean reversion: coins that fell hard over the last 3 days tend to bounce. It will
        often point the opposite way from the trend on the chart — that is the strategy working as
        designed, not a contradiction. Of every factor this screen tracks, this is currently the
        only one with evidence it makes money after costs.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label={lookupMetric('factor_net_spread').label}
          definition={lookupMetric('factor_net_spread').definition}
          value={fmtPct(evidence.netSpreadPct, 2)}
        />
        <StatTile
          label={lookupMetric('factor_net_edge_30d').label}
          definition={lookupMetric('factor_net_edge_30d').definition}
          value={fmtPct(evidence.netEdgePer30dPct, 1)}
        />
        <StatTile
          label={lookupMetric('factor_edge_t_stat').label}
          definition={lookupMetric('factor_edge_t_stat').definition}
          value={fmtNum(evidence.edgeTStat, 2)}
        />
        <StatTile
          label={lookupMetric('factor_edge_train_spread').label}
          definition={lookupMetric('factor_edge_train_spread').definition}
          value={fmtPct(evidence.trainNetSpreadPct, 2)}
        />
        <StatTile
          label={lookupMetric('factor_edge_validation_spread').label}
          definition={lookupMetric('factor_edge_validation_spread').definition}
          value={fmtPct(evidence.validationNetSpreadPct, 2)}
        />
      </div>

      {candidates.length > 0 ? (
        <div className="mt-8">
          <div className="label">
            <Term
              label="Position sizing for today's shortlist"
              definition={lookupMetric('size_multiplier').definition}
            />
          </div>
          <div className="list mt-3 grid gap-2">
            {candidates.map((row) => {
              const side = sideMeta(row.side);
              return (
                <div
                  key={`${row.symbol}:${row.side}`}
                  className="list-row flex justify-between gap-3 text-[13px]"
                >
                  <span className="flex items-center gap-1.5">
                    <strong>{row.symbol}</strong>
                    <span className={`setup-badge ${side.tone}`}>{side.label}</span>
                  </span>
                  <span>
                    {row.scores.size_multiplier == null
                      ? '-'
                      : `${fmtNum(row.scores.size_multiplier, 2)}x`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatTile({
  label,
  definition,
  value,
}: {
  label: string;
  definition: string;
  value: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        <Term label={label} definition={definition} />
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
