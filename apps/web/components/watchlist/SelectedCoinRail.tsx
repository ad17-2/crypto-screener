import type { DashboardRow } from '@crypto-screener/contracts';
import type { ReactNode } from 'react';
import { Panel } from '@/components/layout/Panel';
import { QualityFlagChip } from '@/components/QualityFlagChip';
import { Term } from '@/components/ui/Tooltip';
import {
  lookupConflictCode,
  lookupConfluenceFamily,
  lookupFactor,
  lookupMetric,
  lookupSetup,
  lookupSignalConflictLabel,
  lookupTechnicalPattern,
  lookupWatchlist,
} from '@/lib/copy';
import { positioningDivergence, tradingViewUrl } from '@/lib/dashboard-row';
import {
  conflictTone,
  confluenceToneClass,
  fmtNum,
  fmtPct,
  fmtUsd,
  numeric,
  ordinal,
  qualityTone,
} from '@/lib/format';
import { sideMeta } from './WatchlistTable';

export interface SelectedCoinRailProps {
  row: DashboardRow | null;
}

export function SelectedCoinRail({ row }: SelectedCoinRailProps) {
  if (!row) {
    return (
      <Panel title="Selected Coin" meta="" aria-label="Selected coin detail">
        <div className="py-7 px-3 text-muted text-center">Select a watchlist row</div>
      </Panel>
    );
  }

  const flags = row.data_quality_flags;
  const conflicts = row.signal_conflicts;
  const href = tradingViewUrl(row);

  return (
    <Panel
      title="Selected Coin"
      meta={lookupSetup(row.setup).label}
      aria-label="Selected coin detail"
    >
      <div className="detail-body p-3 grid gap-3">
        <div className="detail-title flex justify-between items-start gap-2.5">
          <div>
            <div className="detail-symbol text-xl font-extrabold leading-tight">
              {href !== '#' ? (
                <a className="symbol-link" href={href} target="_blank" rel="noopener noreferrer">
                  {row.symbol || '-'}
                </a>
              ) : (
                (row.symbol ?? '-')
              )}
            </div>
            <div className="driver-line">{formatPrice(row.price_usd)}</div>
          </div>
          <div className="detail-actions flex gap-1.5 flex-wrap justify-end">
            <a
              className="detail-link inline-flex items-center h-7 border border-line rounded-md px-2 text-ink no-underline text-xs font-bold"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              TradingView
            </a>
          </div>
        </div>

        <VerdictBlock row={row} />
        <ConfluenceStrip row={row} />

        <div className="label">Why this coin</div>
        <ReasonStack row={row} />

        <div className="label">Metrics</div>
        <MetricTiles row={row} />

        <DetailSection title="Chart detail (4h)">
          <ChartDetailBlock row={row} />
        </DetailSection>
        <DetailSection title="History">
          <HistoryBlock row={row} />
        </DetailSection>

        {conflicts.length > 0 ? (
          <>
            <div className="label">Signal conflicts</div>
            <ConflictList row={row} />
          </>
        ) : null}

        {flags.length > 0 ? (
          <div className="quality-flag-list flex flex-wrap gap-1">
            {flags.map((flag) => (
              <QualityFlagChip key={flag} flag={flag} />
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** fmtUsd's K/M/B/T compaction is wrong for a per-coin price (e.g. "$67.23K" for a $67,234 coin) -- this scales decimals instead. */
function formatPrice(value: number | null): string {
  if (value === null) return 'Price unavailable';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return `$${value.toFixed(digits)}`;
}

function signTone(value: unknown): 'pos' | 'neg' | undefined {
  const n = numeric(value);
  if (n === null || n === 0) return undefined;
  return n > 0 ? 'pos' : 'neg';
}

function VerdictBlock({ row }: { row: DashboardRow }) {
  const side = sideMeta(row.side);
  const setup = lookupSetup(row.setup);
  const conflict = lookupSignalConflictLabel(row.signal_conflict_label);
  const conf = row.confluence;
  return (
    <div className="grid gap-1.5">
      <div className="detail-badges flex flex-wrap gap-1.5">
        <span className={`setup-badge ${side.tone}`}>{side.label}</span>
        <span className={`setup-badge ${row.setup_tone || 'neutral'}`}>{setup.label}</span>
        <span
          className={`conflict-badge ${conflictTone(row.signal_conflict_label)}`}
          title={conflict.definition}
        >
          {conflict.label}
        </span>
      </div>
      <p className="text-sm text-ink m-0 leading-snug">
        {side.label} setup: {setup.label}.{' '}
        {conf.families.length > 0
          ? `${conf.aligned} of ${conf.total} signal groups agree.`
          : 'No confluence data for this row.'}
      </p>
    </div>
  );
}

function ConfluenceStrip({ row }: { row: DashboardRow }) {
  const conf = row.confluence;
  if (!conf.families.length) return null;
  const dirLabel = conf.direction === 'short' ? 'short' : 'long';
  return (
    <div className="conf-strip">
      <div className="conf-strip-headline">
        {conf.aligned} of {conf.total} signals align {dirLabel}
      </div>
      <div className="conf-strip-row">
        {conf.families.map((family) => {
          const meta = lookupConfluenceFamily(family.key);
          return (
            <span
              key={family.key}
              className={`conf-strip-cell ${confluenceToneClass(family.tone)}`}
            >
              <Term label={meta.label} definition={meta.definition} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// "Why this coin" -- reason_parts carries kind/label/value/tone/help, but only `kind` and (for
// the 'metric' bucket) `value` are structured enough to trust; `label`/`help` are API prose the
// HARD RULE forbids rendering raw. The label sets below are the exact, verified fixed strings
// apps/api/src/dashboard/rows.ts `reasonParts()`/`appendReasonMetric()` emits (small, closed
// sets), used only as an internal lookup key to pick the right copy.ts entry -- never rendered.
// copy.ts has no dedicated dictionary for a row's composite `score` (units vary by score_field)
// or for RSI, so those two entries below are authored locally rather than sourced from copy.ts.
// ---------------------------------------------------------------------------------------------

const SCORE_FIELD_META: Record<string, { label: string; definition: string }> = {
  factor_score: {
    label: 'Score (factor)',
    definition:
      'The weighted directional factor score behind this row, roughly -1 to 1. Not on the same scale as Rank or the long/short/crowding scores below.',
  },
  long_score: {
    label: 'Score (long)',
    definition:
      "This row's long-side composite score, roughly 0-100+. Not on the same scale as the factor score.",
  },
  short_score: {
    label: 'Score (short)',
    definition:
      "This row's short-side composite score, roughly 0-100+. Not on the same scale as the factor score.",
  },
  crowded_long_score: {
    label: 'Score (crowded-long)',
    definition:
      "This row's crowded-long composite score, roughly 0-100+. Not on the same scale as the factor score.",
  },
  squeeze_risk_score: {
    label: 'Score (squeeze-risk)',
    definition:
      "This row's squeeze-risk composite score, roughly 0-100+. Not on the same scale as the factor score.",
  },
  regime_fit_score: {
    label: 'Score (regime-fit)',
    definition:
      "This row's regime-fit composite score -- a base score adjusted for how well it matches today's regime and breadth. Not on the same scale as the factor score.",
  },
};

const DEFAULT_SCORE_FIELD_META = {
  label: 'Score',
  definition:
    "This row's ranking score. Units vary by watchlist -- see Rank for a number that's comparable across lists.",
};

function scoreFieldMeta(scoreField: string): { label: string; definition: string } {
  return SCORE_FIELD_META[scoreField] ?? DEFAULT_SCORE_FIELD_META;
}

const RSI_META = {
  label: 'RSI (4h)',
  definition:
    '14-period Relative Strength Index on the 4h chart. Above 70 is typically overbought, below 30 oversold.',
};

const REASON_METRIC_META: Record<string, { label: string; definition: string }> = {
  '24h': lookupMetric('change_24h'),
  'OI 24h': { label: 'OI 24h', definition: lookupMetric('open_interest').definition },
  Funding: lookupMetric('funding'),
  'L/S': lookupMetric('crowding'),
  Factor: SCORE_FIELD_META.factor_score ?? DEFAULT_SCORE_FIELD_META,
  Confidence: lookupMetric('conviction'),
  RSI: RSI_META,
};

/** apps/api/src/dashboard/taxonomy.ts FACTOR_LABELS -- the exact, exhaustive reverse map from a driver reason-part's API label back to the factor `name` copy.ts's FACTOR dict is keyed by. */
const REASON_FACTOR_LABEL_TO_NAME: Record<string, string> = {
  Momentum: 'momentum_24h',
  'Reversal 3d': 'reversal_3d',
  'OI/Price': 'oi_price_signal',
  Funding: 'funding_rate_contrarian',
  'L/S': 'ls_ratio_contrarian',
  Liquidations: 'liquidation_imbalance',
  '4h Trend': 'technical_trend_4h',
  '4h Momentum': 'technical_momentum_4h',
  'OI Acceleration': 'oi_acceleration_signal',
  'Funding Persistence': 'funding_persistence_contrarian',
  'Taker Flow': 'taker_flow_24h',
  'Liq Pressure': 'liquidation_pressure_24h',
};

interface ReasonPartView {
  key: string;
  label: string;
  definition: string;
  value: string;
  tone: string;
}

function resolveReasonPart(
  row: DashboardRow,
  part: DashboardRow['reason_parts'][number],
  index: number,
): ReasonPartView | null {
  // apps/api/src/dashboard/rows.ts still emits the legacy 'bad' tone on the wire for a couple of
  // reason parts (read-only reference, not editable here) -- normalize it to 'neg' at this
  // consumption boundary so 'bad' never reaches the rendered className.
  const tone = part.tone === 'bad' ? 'neg' : part.tone;
  if (part.kind === 'metric') {
    const meta = REASON_METRIC_META[part.label];
    if (!meta) return null;
    return {
      key: `metric-${index}`,
      label: meta.label,
      definition: meta.definition,
      value: part.value,
      tone,
    };
  }
  if (part.kind === 'driver') {
    const name = REASON_FACTOR_LABEL_TO_NAME[part.label];
    const factor = lookupFactor(name);
    return {
      key: `driver-${index}`,
      label: factor.label,
      definition: factor.definition,
      value: part.value,
      tone,
    };
  }
  if (part.kind === 'context') {
    if (part.label === 'Tech') {
      const tech = lookupTechnicalPattern(row.technical_setup);
      return {
        key: 'context-tech',
        label: 'Chart read (4h)',
        definition: tech.definition,
        value: tech.label,
        tone,
      };
    }
    if (part.label === 'Signals') {
      const conflict = lookupSignalConflictLabel(row.signal_conflict_label);
      return {
        key: 'context-signals',
        label: 'Signal agreement',
        definition: conflict.definition,
        value: conflict.label,
        tone,
      };
    }
    if (part.label === 'Crowding') {
      const watchlistId = row.side === 'fade-long' ? 'crowded_longs' : 'squeeze_risks';
      const meta = lookupWatchlist(watchlistId);
      return {
        key: 'context-crowding',
        label: meta.label,
        definition: meta.definition,
        value: sideMeta(row.side).label,
        tone,
      };
    }
    return null;
  }
  if (part.kind === 'quality') {
    const meta = lookupMetric('data_quality');
    const count = row.data_quality_flags.length;
    return {
      key: `quality-${index}`,
      label: meta.label,
      definition: meta.definition,
      value: `${count} flag${count === 1 ? '' : 's'}`,
      tone,
    };
  }
  return null;
}

function ReasonStack({ row }: { row: DashboardRow }) {
  const percentileByLabel: Record<string, number | null | undefined> = {
    Funding: row.funding_percentile,
    'OI 24h': row.oi_change_percentile,
    'L/S': row.positioning_percentile,
  };

  const views = row.reason_parts
    .map((part, index) => ({ part, view: resolveReasonPart(row, part, index) }))
    .filter(
      (entry): entry is { part: DashboardRow['reason_parts'][number]; view: ReasonPartView } =>
        entry.view !== null,
    );

  if (!views.length) return <div className="driver-line">No reasoning available for this row.</div>;

  return (
    <div className="reason-stack">
      {views.map(({ part, view }) => {
        const pct = percentileByLabel[part.label];
        return (
          <span
            key={view.key}
            className={`reason-part ${part.kind || 'metric'} ${view.tone || 'neutral'}`}
            title={view.definition}
          >
            <span>{view.label}</span>
            <strong>{view.value}</strong>
            {pct == null ? null : <span className="reason-pct">{ordinal(pct)} pct</span>}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="detail-section border-2 border-line rounded-md bg-panel-2 overflow-hidden border-l-gold">
      <summary className="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer list-none text-ink text-xs font-semibold uppercase tracking-wide">
        {title}
      </summary>
      <div className="detail-section-body px-2.5 pb-2.5 grid gap-2">{children}</div>
    </details>
  );
}

function StatTile({
  label,
  definition,
  value,
  tone,
}: {
  label: string;
  definition?: string | undefined;
  value: ReactNode;
  tone?: 'pos' | 'neg' | 'warn' | undefined;
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <div className="stat-label">
        {definition ? <Term label={label} definition={definition} /> : label}
      </div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function MetricTiles({ row }: { row: DashboardRow }) {
  const scoreMeta = scoreFieldMeta(row.score_field);
  const qTone = qualityTone(row.quality);
  return (
    <div className="grid grid-cols-3 max-[900px]:grid-cols-2 max-[480px]:grid-cols-1 gap-2">
      <StatTile
        label={lookupMetric('priority').label}
        definition={lookupMetric('priority').definition}
        value={fmtNum(row.priority)}
      />
      <StatTile
        label={scoreMeta.label}
        definition={scoreMeta.definition}
        value={fmtNum(row.score)}
      />
      <StatTile
        label={lookupMetric('conviction').label}
        definition={lookupMetric('conviction').definition}
        value={row.confidence_score == null ? '-' : fmtNum(row.confidence_score, 0)}
      />
      <StatTile
        label={lookupMetric('data_quality').label}
        definition={lookupMetric('data_quality').definition}
        value={row.quality}
        tone={qTone || undefined}
      />
      <StatTile
        label="24h"
        value={fmtPct(row.price_change_24h_pct)}
        tone={signTone(row.price_change_24h_pct)}
      />
      <StatTile
        label="OI 24h"
        value={fmtPct(row.oi_change_24h_pct)}
        tone={signTone(row.oi_change_24h_pct)}
      />
      <StatTile
        label={lookupMetric('funding').label}
        definition={lookupMetric('funding').definition}
        value={fmtPct(row.funding_rate_pct, 4)}
        tone={signTone(row.funding_rate_pct)}
      />
      <StatTile
        label={lookupMetric('crowding').label}
        definition={lookupMetric('crowding').definition}
        value={row.long_short_ratio == null ? '-' : fmtNum(row.long_short_ratio)}
      />
      <StatTile label="Volume" value={fmtUsd(row.quote_volume_usd)} />
      <StatTile
        label={lookupMetric('open_interest').label}
        definition={lookupMetric('open_interest').definition}
        value={fmtUsd(row.open_interest_usd)}
      />
      <StatTile
        label={lookupMetric('round_trip_cost').label}
        definition={lookupMetric('round_trip_cost').definition}
        value={fmtPct(row.scores.round_trip_cost_pct, 3)}
      />
      <PositioningTile row={row} />
    </div>
  );
}

const POSITIONING_DEFINITION =
  'Retail (all-account) long/short ratio vs the top-traders long/short ratio. When they diverge, retail positioning may be crowded against smarter money.';

function PositioningTile({ row }: { row: DashboardRow }) {
  const retail = row.long_short_account_ratio;
  const top = row.top_trader_long_short_ratio;
  const divergence = positioningDivergence(row);
  const value = `${retail == null ? '-' : fmtNum(retail)}x / ${top == null ? '-' : fmtNum(top)}x`;
  const badgeTone = divergence
    ? divergence.tone === 'warn'
      ? 'warn'
      : divergence.tone === 'pos'
        ? 'pos'
        : 'neutral'
    : 'neutral';
  return (
    <div className="stat">
      <div className="stat-label">
        <Term label="Positioning (retail / top)" definition={POSITIONING_DEFINITION} />
      </div>
      <div className="stat-value flex items-center gap-1.5 flex-wrap">
        <span>{value}</span>
        {divergence && retail != null && top != null ? (
          <span className={`conflict-badge ${badgeTone}`}>{divergence.label}</span>
        ) : null}
      </div>
    </div>
  );
}

function ChartDetailBlock({ row }: { row: DashboardRow }) {
  const state = row.technical_state;
  const hasData = Object.keys(state).length > 0 || Boolean(row.technical_setup);
  if (!hasData) {
    return <div className="driver-line">No CoinGlass OHLC technical snapshot for this row.</div>;
  }
  const pattern = lookupTechnicalPattern(row.technical_setup);
  return (
    <div className="grid grid-cols-2 max-[680px]:grid-cols-1 gap-2 -mt-1">
      <StatTile label="Chart read (4h)" definition={pattern.definition} value={pattern.label} />
      <StatTile label="RSI (14)" value={fmtNum(state.rsi_14, 1)} />
      <StatTile
        label="MACD histogram"
        value={fmtPct(state.macd_histogram_pct, 3)}
        tone={signTone(state.macd_histogram_pct)}
      />
      <StatTile label="ATR (14)" value={fmtPct(state.atr_14_pct, 2)} />
      <StatTile label="Bollinger width" value={fmtPct(state.bb_width_pct, 2).replace('+', '')} />
      <StatTile label="Bollinger position" value={fmtNum(state.bb_position, 2)} />
      <StatTile
        label="EMA20 distance"
        value={fmtPct(state.distance_ema20_pct, 2)}
        tone={signTone(state.distance_ema20_pct)}
      />
      <StatTile
        label="Trend score"
        value={fmtNum(state.technical_trend_score, 2)}
        tone={signTone(state.technical_trend_score)}
      />
      <StatTile
        label="Momentum score"
        value={fmtNum(state.technical_momentum_score, 2)}
        tone={signTone(state.technical_momentum_score)}
      />
      <StatTile
        label="Candles"
        value={`${state.technical_candle_count ?? '-'} ${state.technical_interval || ''}`}
      />
    </div>
  );
}

function ConflictList({ row }: { row: DashboardRow }) {
  const conflicts = row.signal_conflicts;
  return (
    <div className="conflict-block">
      {conflicts.map((item) => {
        const meta = lookupConflictCode(item.code);
        return (
          <div key={item.code} className="conflict-row">
            <strong title={meta.definition}>{meta.label}</strong>
            <span>Severity {fmtNum(item.severity, 2)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HistoryBlock({ row }: { row: DashboardRow }) {
  if (row.history.length < 2) {
    return <div className="driver-line">More saved runs needed for multi-point trend lines.</div>;
  }
  return (
    <div className="history-block">
      <HistoryLine label="Score" points={row.history} field={scoreFieldOf(row)} />
      <HistoryLine label="OI 24h" points={row.history} field="oi_change_24h_pct" />
      <HistoryLine label="Funding" points={row.history} field="funding_rate_pct" />
      <HistoryLine label="RSI" points={row.history} field="rsi_14" />
    </div>
  );
}

type HistoryField =
  | 'factor_score'
  | 'long_score'
  | 'short_score'
  | 'crowded_long_score'
  | 'squeeze_risk_score'
  | 'oi_change_24h_pct'
  | 'funding_rate_pct'
  | 'rsi_14';

function scoreFieldOf(row: DashboardRow): HistoryField {
  const field = row.score_field;
  if (
    field === 'factor_score' ||
    field === 'long_score' ||
    field === 'short_score' ||
    field === 'crowded_long_score' ||
    field === 'squeeze_risk_score'
  ) {
    return field;
  }
  return 'factor_score';
}

function HistoryLine({
  label,
  points,
  field,
}: {
  label: string;
  points: DashboardRow['history'];
  field: HistoryField;
}) {
  return (
    <div className="history-line">
      <span>{label}</span>
      <Sparkline points={points} field={field} />
    </div>
  );
}

function Sparkline({ points, field }: { points: DashboardRow['history']; field: HistoryField }) {
  const values = points
    .map((point) => numeric(point[field]))
    .filter((value): value is number => value !== null);
  if (values.length < 2) return <span className="driver-line">Need history</span>;

  const width = 92;
  const height = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const coords = values
    .map((value, index) => {
      const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const firstValue = values[0] ?? 0;
  const lastValue = values[values.length - 1] ?? 0;
  const tone = lastValue > firstValue ? 'good' : lastValue < firstValue ? 'neg' : 'neutral';

  return (
    <svg
      className="sparkline block w-[92px] h-[28px] ml-auto max-[900px]:ml-0"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <line className="axis" x1={0} y1={height - 2} x2={width} y2={height - 2} />
      <polyline className={tone} points={coords} />
    </svg>
  );
}
