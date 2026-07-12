import { InfoTip, Term } from '@/components/ui/Tooltip';
import { lookupFactor, lookupMetric, lookupRobustnessVerdict } from '@/lib/copy';
import { fmtNum, fmtPct } from '@/lib/format';
import {
  type FactorDecayInfo,
  type FactorHealthRow,
  factorHealthRows,
  negativeWeightRows,
} from '@/lib/model-health';

export interface FactorWeightsStageProps {
  /** untyped on the wire — read defensively. */
  modelWeights: unknown;
}

/**
 * Stage 2: "What the model is betting on" -- every factor's weight, ranked by size, with a
 * badge that says whether the weight is a starting assumption ("Prior") or a measured track
 * record ("Measured"), and an expandable detail exposing the underlying numbers for every
 * factor -- not just the ones the old panel considered "IC mode".
 */
export function FactorWeightsStage({ modelWeights }: FactorWeightsStageProps) {
  const rows = factorHealthRows(modelWeights);

  if (rows.length === 0) {
    return (
      <section className="stage" aria-label="What the model is betting on">
        <p className="stage-eyebrow m-0">What the model is betting on</p>
        <h3 className="stage-title mt-2 mb-1">No factor weights for this run</h3>
      </section>
    );
  }

  const priorCount = rows.filter((row) => row.mode === 'prior').length;
  const negatives = negativeWeightRows(rows);
  const maxAbsWeight = Math.max(...rows.map((row) => Math.abs(row.weight ?? 0)), 0.0001);

  return (
    <section className="stage" aria-label="What the model is betting on">
      <p className="stage-eyebrow m-0">What the model is betting on</p>
      <h3 className="stage-title mt-2 mb-1">
        {priorCount} of {rows.length} weights come from priors
      </h3>
      <p className="text-muted text-[13px] max-w-[62ch]">
        Every factor below gets a weight in today's ranking, whether it's a{' '}
        <Term label="Prior" definition={lookupMetric('prior_weight').definition} /> — a starting
        assumption — or{' '}
        <Term label="Measured" definition={lookupMetric('measured_weight').definition} /> — backed
        by its own track record.
      </p>

      {negatives.length > 0 ? <NegativeWeightCallout rows={negatives} /> : null}

      <div className="mt-6">
        {rows.map((row) => (
          <FactorRow key={row.name} row={row} maxAbsWeight={maxAbsWeight} />
        ))}
      </div>
    </section>
  );
}

function NegativeWeightCallout({ rows }: { rows: FactorHealthRow[] }) {
  return (
    <div className="risk-callout mt-5">
      <div className="text-[13px] font-semibold text-down">
        The model inverted {rows.length === 1 ? 'a signal' : `${rows.length} signals`}
      </div>
      {rows.map((row) => {
        const factor = lookupFactor(row.name);
        return (
          <p key={row.name} className="mt-1.5 text-[13px] text-muted leading-snug">
            <strong className="text-ink">{factor.label}</strong> has a negative weight (
            <strong className="font-mono tabular-nums text-ink">{fmtNum(row.weight, 3)}</strong>
            ). Its measured track record has pointed the wrong way often enough
            {row.tStat !== null ? ` (t = ${fmtNum(row.tStat, 2)})` : ''} that the model flipped its
            sign instead of ignoring it — a strong reading on this factor now counts against, not
            for, that direction.
          </p>
        );
      })}
    </div>
  );
}

function FactorRow({ row, maxAbsWeight }: { row: FactorHealthRow; maxAbsWeight: number }) {
  const factor = lookupFactor(row.name);
  const width = maxAbsWeight > 0 ? Math.round((Math.abs(row.weight ?? 0) / maxAbsWeight) * 100) : 0;
  // Bar length already carries the magnitude, and a positive weight is the unremarkable case -- 11 of
  // 12 are. Only an INVERTED weight (the model betting against a factor) is worth a colour.
  const tone = row.weight !== null && row.weight < 0 ? 'neg' : '';
  const isMeasured = row.mode === 'measured';
  const badgeDefinition = lookupMetric(isMeasured ? 'measured_weight' : 'prior_weight').definition;

  return (
    <div className="py-3 border-b border-line last:border-b-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Term label={factor.label} definition={factor.definition} />
        <span className="flex items-center gap-2 shrink-0">
          <span className={`status-pill ${isMeasured ? 'pos' : 'warn'}`} title={badgeDefinition}>
            {isMeasured ? 'Measured' : 'Prior'}
          </span>
          <strong className="font-mono tabular-nums text-[13px]">{fmtNum(row.weight, 3)}</strong>
        </span>
      </div>
      <div className="factor-track mt-2">
        <div className={`factor-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <details className="detail-section mt-2 border border-line rounded-md bg-panel-2 overflow-hidden">
        <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer list-none text-muted text-[11px] font-semibold uppercase tracking-wide">
          Measured numbers
        </summary>
        <div className="px-2.5 pb-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <DetailStat label="IC" metricKey="ic" value={fmtNum(row.ic, 3)} />
          <DetailStat label="t-stat" metricKey="t_stat" value={fmtNum(row.tStat, 2)} />
          <DetailStat label="Periods" metricKey="n_periods" value={String(row.nPeriods)} />
          <DetailStat
            label="Credibility"
            metricKey="credibility"
            value={fmtNum(row.credibilityK, 2)}
          />
          <DetailStat
            label="Out-of-sample IC"
            metricKey="out_of_sample"
            value={fmtNum(row.oosIc, 3)}
          />
          <DecayDetailStat decay={row.decay} />
          <DetailStat
            label="Net spread"
            metricKey="factor_net_spread"
            value={fmtPct(row.netSpreadPct, 2)}
          />
          <DetailStat
            label="Net edge / 30d"
            metricKey="factor_net_edge_30d"
            value={fmtPct(row.netEdgePer30dPct, 1)}
          />
          <DetailStat
            label="Edge t-stat"
            metricKey="factor_edge_t_stat"
            value={fmtNum(row.edgeTStat, 2)}
          />
        </div>
        <RobustnessLine robustness={row.robustness} />
      </details>
    </div>
  );
}

function DetailStat({
  label,
  metricKey,
  value,
}: {
  label: string;
  metricKey: string;
  value: string;
}) {
  return (
    <div>
      <span className="stat-label inline-flex items-center gap-1">
        {label}
        <InfoTip term={label} definition={lookupMetric(metricKey).definition} />
      </span>
      <div className="stat-value text-[13px]">{value}</div>
    </div>
  );
}

function DecayDetailStat({ decay }: { decay: FactorDecayInfo }) {
  const maxTestedHours =
    decay.curve.length > 0 ? Math.max(...decay.curve.map((p) => p.horizonHours)) : null;
  const value = !decay.sufficient
    ? 'Not measured'
    : decay.holdsHours !== null
      ? `Fades by ~${decay.holdsHours}h`
      : maxTestedHours !== null
        ? `No fade out to ${maxTestedHours}h`
        : 'Not measured';
  return (
    <div>
      <span className="stat-label inline-flex items-center gap-1">
        Decay
        <InfoTip term="Decay" definition={lookupMetric('holds').definition} />
      </span>
      <div className="stat-value text-[13px]">{value}</div>
    </div>
  );
}

function RobustnessLine({ robustness }: { robustness: string | null }) {
  if (!robustness) return null;
  const tone = robustness === 'robust' ? 'pos' : robustness === 'overfit' ? 'neg' : 'neutral';
  const verdict = lookupRobustnessVerdict(robustness);
  return (
    <div className="px-2.5 pb-2.5 -mt-1">
      <span className={`status-pill ${tone}`} title={verdict.definition}>
        {verdict.label}
      </span>
    </div>
  );
}
