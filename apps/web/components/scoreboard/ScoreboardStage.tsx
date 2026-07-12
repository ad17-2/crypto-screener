import type { Scoreboard } from '@crypto-screener/contracts';
import { Term } from '@/components/ui/Tooltip';
import { lookupMetric } from '@/lib/copy';
import { fmtPct, fmtRate } from '@/lib/format';

export interface ScoreboardStageProps {
  scoreboard: Scoreboard;
}

function netTone(value: number | null): 'pos' | 'neg' | undefined {
  if (value === null || value === 0) return undefined;
  return value > 0 ? 'pos' : 'neg';
}

/**
 * Layer 4: what the screen called, what happened, net of costs. Accountability, not a pitch --
 * n_calls >= n_resolved >= n_scored always (apps/api/src/db/recommendations.ts
 * computeScoreboard()), and status stays 'insufficient' until n_scored clears the bar to trust
 * hit_rate_pct as more than noise.
 */
export function ScoreboardStage({ scoreboard }: ScoreboardStageProps) {
  const { status, n_calls, n_resolved, n_scored } = scoreboard;

  return (
    <section className="stage" aria-label="The scoreboard">
      <p className="stage-eyebrow m-0">The scoreboard</p>
      <h3 className="stage-title mt-2 mb-1">What it called, what happened</h3>
      <p className="text-muted text-[13px] max-w-[62ch]">
        Every directional call the screen has logged, tracked against what actually happened, net of
        estimated trading costs. Not a backtest — these are real snapshots saved as the screen ran.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-2">
        <StatTile
          label="Calls logged"
          definition="Coins the screen surfaced as a directional call (long, short, crowded-long fade, or squeeze-risk) on some past run."
          value={String(n_calls)}
        />
        <StatTile
          label="Resolved"
          definition="Calls where enough time has passed to know what the price actually did afterward."
          value={String(n_resolved)}
        />
        <StatTile
          label="Scored"
          definition="Resolved calls with a known trading-cost estimate, graded net of that cost. A resolved call with no directional thesis (a majors/'core' row) is never scored."
          value={String(n_scored)}
        />
      </div>

      {status === 'insufficient' ? (
        <p className="mt-6 text-[13px] text-muted max-w-[62ch]">
          Only {n_scored} scored call{n_scored === 1 ? '' : 's'} so far — too few to trust a hit
          rate.{' '}
          {n_calls - n_resolved > 0
            ? `${n_calls - n_resolved} call${n_calls - n_resolved === 1 ? '' : 's'} logged but not yet resolved.`
            : 'Check back once more calls have resolved.'}
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StatTile
            label={lookupMetric('hit_rate').label}
            definition={lookupMetric('hit_rate').definition}
            value={fmtRate(scoreboard.hit_rate_pct, 1)}
            tone={
              scoreboard.hit_rate_pct === null
                ? undefined
                : scoreboard.hit_rate_pct >= 50
                  ? 'pos'
                  : 'neg'
            }
          />
          <StatTile
            label={lookupMetric('mean_net_return').label}
            definition={lookupMetric('mean_net_return').definition}
            value={fmtPct(scoreboard.mean_net_return_pct, 3)}
            tone={netTone(scoreboard.mean_net_return_pct)}
          />
          <StatTile
            label={lookupMetric('cumulative_net_return').label}
            definition={lookupMetric('cumulative_net_return').definition}
            value={fmtPct(scoreboard.cumulative_net_return_pct, 2)}
            tone={netTone(scoreboard.cumulative_net_return_pct)}
          />
        </div>
      )}
    </section>
  );
}

function StatTile({
  label,
  definition,
  value,
  tone,
}: {
  label: string;
  definition: string;
  value: string;
  tone?: 'pos' | 'neg' | undefined;
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="stat-label">
        <Term label={label} definition={definition} />
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
