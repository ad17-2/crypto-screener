import type { FactorCorrelation, ModelWeights } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import { fmtNum } from '@/lib/format';
import { asRecord } from '@/lib/wire';

export interface FactorWeightsPanelProps {
  modelWeights: ModelWeights;
}

type FactorWeight = ModelWeights['factors'][number];

interface DecayPoint {
  horizon_hours: number;
  mean_ic: number | null;
  insufficient: boolean;
}

interface FactorDecay {
  sufficient: boolean;
  holds_hours: number | null;
  curve: DecayPoint[];
}

/**
 * `.factor-track`/`.factor-fill` below are `<div>`s, not `<span>`s: CSS `width` has no effect on
 * non-replaced inline elements, so the fill bar wouldn't render if these were inline.
 */
export function FactorWeightsPanel({ modelWeights }: FactorWeightsPanelProps) {
  const regime = asRecord(modelWeights.regime);
  const regimeIcFactors = Array.isArray(regime.factors_using_regime_ic)
    ? regime.factors_using_regime_ic
    : [];
  const factorCount = modelWeights.factors.length;
  const pooledCount = Math.max(0, factorCount - regimeIcFactors.length);
  const regimeLabel = typeof regime.label === 'string' ? regime.label : 'mixed';
  const mode = modelWeights.mode || 'prior';
  const meta = `${mode} · ${regimeLabel} · ${regimeIcFactors.length} regime-IC / ${pooledCount} pooled`;

  const factors = [...modelWeights.factors].sort(
    (a, b) => Math.abs(b.weight ?? 0) - Math.abs(a.weight ?? 0),
  );
  const maxAbs = Math.max(...factors.map((f) => Math.abs(f.weight ?? 0)), 0.0001);
  const decayByFactor = asRecord(modelWeights.factor_decay);

  return (
    <Panel title="Factor Weights" meta={meta} accent="gold">
      {factors.length === 0 ? (
        <div className="py-7 px-3 text-muted text-center">No factor weights</div>
      ) : (
        <div className="list p-3 grid gap-2">
          {factors.map((factor) => (
            <WeightRow
              key={factor.name}
              factor={factor}
              maxAbs={maxAbs}
              decay={asFactorDecay(decayByFactor[factor.name])}
            />
          ))}
          <FactorCorrelations correlations={modelWeights.factor_correlations} />
        </div>
      )}
    </Panel>
  );
}

function WeightRow({
  factor,
  maxAbs,
  decay,
}: {
  factor: FactorWeight;
  maxAbs: number;
  decay: FactorDecay;
}) {
  const weight = factor.weight ?? 0;
  const width = Math.round((Math.abs(weight) / maxAbs) * 100);
  const tone = weight > 0 ? 'pos' : weight < 0 ? 'neg' : 'neutral';
  const regimeMode = typeof factor.regime_mode === 'string' ? factor.regime_mode : null;
  const regimeMarker = regimeMode === 'regime-ic' ? ` · R:IC ${fmtNum(factor.regime_ic, 2)}` : '';
  const showMultiplier =
    factor.regime_multiplier !== null && Math.abs(factor.regime_multiplier - 1) >= 0.01;

  return (
    <div className="weight-row grid grid-cols-[minmax(90px,1fr)_minmax(0,1.2fr)_auto] gap-2 items-center text-xs">
      <div className="weight-label grid gap-0.5 min-w-0">
        <strong>{factor.label || factor.name || '-'}</strong>
        {factor.mode === 'ic' ? (
          <span className="driver-line">
            IC {fmtNum(factor.ic, 2)} · t {fmtNum(factor.t_stat, 1)} · k{' '}
            {fmtNum(factor.credibility_k, 2)} · {factor.n_periods}p{regimeMarker}
            {showMultiplier ? ` · x${fmtNum(factor.regime_multiplier, 2)}` : ''}
          </span>
        ) : regimeMode === 'regime-ic' ? (
          <span className="driver-line">R:IC {fmtNum(factor.regime_ic, 2)}</span>
        ) : null}
        <div className="decay-row flex items-center gap-1.5 flex-wrap">
          <DecaySparkline curve={decay.curve} />
          <DecayHoldsTag decay={decay} />
          <RobustnessBadge factor={factor} />
        </div>
      </div>
      <div className="factor-track">
        <div className={`factor-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <div className="weight-meta flex items-center gap-1.5 justify-self-end">
        <span className={`status-pill ${factor.mode === 'ic' ? '' : 'warn'}`}>
          {(factor.mode || 'prior').toUpperCase()}
        </span>
        <strong>{fmtNum(factor.weight, 3)}</strong>
      </div>
    </div>
  );
}

function DecaySparkline({ curve }: { curve: DecayPoint[] }) {
  if (curve.length === 0) return null;
  const maxAbs = Math.max(
    ...curve.map((point) =>
      point.insufficient || point.mean_ic === null ? 0 : Math.abs(point.mean_ic),
    ),
    0.0001,
  );
  return (
    <span className="decay-sparkline" aria-hidden="true">
      {curve.map((point) => {
        const hollow = point.insufficient || point.mean_ic === null;
        const absIc = hollow || point.mean_ic === null ? 0 : Math.abs(point.mean_ic);
        const height = hollow ? 3 : Math.max(3, Math.round((absIc / maxAbs) * 14));
        const tone =
          point.mean_ic !== null && point.mean_ic > 0
            ? 'pos'
            : point.mean_ic !== null && point.mean_ic < 0
              ? 'neg'
              : 'neutral';
        const barClass = hollow ? 'decay-bar hollow' : `decay-bar ${tone}`;
        const label = `${point.horizon_hours}h: ${point.mean_ic === null ? 'n/a' : fmtNum(point.mean_ic, 2)}`;
        return (
          <span
            key={point.horizon_hours}
            className={barClass}
            style={{ height: `${height}px` }}
            title={label}
          />
        );
      })}
    </span>
  );
}

function DecayHoldsTag({ decay }: { decay: FactorDecay }) {
  if (!decay.sufficient) {
    return <span className="status-pill neutral decay-holds">insufficient-data</span>;
  }
  if (decay.holds_hours === null) {
    return <span className="status-pill decay-holds">persistent</span>;
  }
  return <span className="status-pill decay-holds">holds ~{decay.holds_hours}h</span>;
}

function RobustnessBadge({ factor }: { factor: FactorWeight }) {
  const verdict = factor.robustness;
  if (typeof verdict !== 'string' || verdict.length === 0) return null;
  const tone = verdict === 'robust' ? '' : verdict === 'overfit' ? 'bad' : 'neutral';
  const tooltip =
    factor.ic !== null && factor.oos_ic !== null
      ? `IS IC ${fmtNum(factor.ic, 2)} vs OOS IC ${fmtNum(factor.oos_ic, 2)}`
      : verdict;
  return (
    <span className={`status-pill ${tone} robustness-badge`} title={tooltip}>
      {verdict}
    </span>
  );
}

function FactorCorrelations({ correlations }: { correlations: FactorCorrelation[] }) {
  if (correlations.length === 0) return null;
  return (
    <div className="factor-correlations border-t border-line pt-2 mt-1 grid gap-1.5">
      <div className="label">Collinearity Flags</div>
      {correlations.map((pair) => (
        <div
          key={`${pair.a}-${pair.b}`}
          className="list-row flex justify-between gap-2 items-center text-xs"
        >
          <span className="min-w-0 truncate">
            {pair.a} / {pair.b}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span className={`status-pill ${correlationTone(pair.verdict)}`}>{pair.verdict}</span>
            <strong>{fmtNum(pair.rho, 2)}</strong>
          </span>
        </div>
      ))}
    </div>
  );
}

function correlationTone(verdict: string): string {
  if (verdict === 'duplicate') return 'bad';
  if (verdict === 'redundant') return 'warn';
  return 'neutral';
}

function asFactorDecay(value: unknown): FactorDecay {
  const record = asRecord(value);
  return {
    sufficient: record.sufficient === true,
    holds_hours: typeof record.holds_hours === 'number' ? record.holds_hours : null,
    curve: Array.isArray(record.curve) ? record.curve.map(asDecayPoint) : [],
  };
}

function asDecayPoint(value: unknown): DecayPoint {
  const record = asRecord(value);
  return {
    horizon_hours: typeof record.horizon_hours === 'number' ? record.horizon_hours : 0,
    mean_ic: typeof record.mean_ic === 'number' ? record.mean_ic : null,
    insufficient: record.insufficient === true,
  };
}
