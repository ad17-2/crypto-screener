import type { DashboardRow } from '@crypto-screener/contracts';
import type { ReactNode } from 'react';
import { Panel } from '@/components/layout/Panel';
import { QualityFlagChip } from '@/components/QualityFlagChip';
import { Term } from '@/components/ui/Tooltip';
import {
  lookupCvdAbsorptionState,
  lookupFactor,
  lookupMetric,
  lookupOiPriceTrendState,
  lookupSetup,
  lookupTechnicalDivergence,
  lookupTechnicalPattern,
  lookupWatchlist,
} from '@/lib/copy';
import {
  divergenceLine,
  emaCrossLine,
  oiPriceQuadrant,
  positioningDivergence,
  tradingViewUrl,
} from '@/lib/dashboard-row';
import { fmtNum, fmtPct, fmtPrice, fmtUsd, numeric, ordinal, qualityTone } from '@/lib/format';
import { FightsBtcChip, SetupConfidenceBadge, sideMeta } from './WatchlistTable';

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
  const href = tradingViewUrl(row);

  return (
    <Panel
      title="Selected Coin"
      meta={lookupSetup(row.setup).label}
      aria-label="Selected coin detail"
    >
      <div className="detail-body pt-3 grid gap-3">
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
            <div className="driver-line">{fmtPrice(row.price_usd)}</div>
          </div>
          <div className="detail-actions flex gap-1.5 flex-wrap justify-end">
            <a
              className="detail-link link text-xs"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              TradingView
            </a>
          </div>
        </div>

        <VerdictBlock row={row} />

        <div className="label">Why this coin</div>
        <ReasonStack row={row} />

        <div className="label">Metrics</div>
        <MetricTiles row={row} />

        <DetailSection title="Chart detail (4h)">
          <ChartDetailBlock row={row} />
        </DetailSection>
        <DetailSection title="Levels (4h)">
          <LevelsBlock row={row} />
        </DetailSection>
        <DetailSection title="History">
          <HistoryBlock row={row} />
        </DetailSection>

        {flags.length > 0 ? (
          <div className="quality-flag-list flex flex-wrap gap-x-4 gap-y-1">
            {flags.map((flag) => (
              <QualityFlagChip key={flag} flag={flag} />
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function signTone(value: unknown): 'pos' | 'neg' | undefined {
  const n = numeric(value);
  if (n === null || n === 0) return undefined;
  return n > 0 ? 'pos' : 'neg';
}

function VerdictBlock({ row }: { row: DashboardRow }) {
  const side = sideMeta(row.side);
  const setup = lookupSetup(row.setup);
  return (
    <div className="grid gap-1.5">
      <div className="detail-badges flex flex-wrap gap-1.5">
        <span className={`setup-badge ${side.tone}`}>{side.label}</span>
        <span className={`setup-badge ${row.setup_tone || 'neutral'}`}>{setup.label}</span>
        {row.setup_confidence ? <SetupConfidenceBadge confidence={row.setup_confidence} /> : null}
        {row.fights_btc ? <FightsBtcChip /> : null}
      </div>
      <p className="text-sm text-ink m-0 leading-snug">
        {side.label} setup: {setup.label}.
      </p>
    </div>
  );
}

// "Why this coin" -- reason_parts carries kind/label/value/tone/help, but only `kind` and (for
// the 'metric' bucket) `value` are structured enough to trust; `label`/`help` are API prose the
// HARD RULE forbids rendering raw. The label sets below are the exact, verified fixed strings
// apps/api/src/dashboard/rows.ts `reasonParts()`/`appendReasonMetric()` emits (small, closed
// sets), used only as an internal lookup key to pick the right copy.ts entry -- never rendered.
// copy.ts has no dedicated dictionary for a row's composite `score` (units vary by score_field)
// or for RSI, so those two entries below are authored locally rather than sourced from copy.ts.

const SCORE_FIELD_META: Record<string, { label: string; definition: string }> = {
  long_score: {
    label: 'Score (long)',
    definition: "This row's long-side composite score, roughly 0-100+.",
  },
  short_score: {
    label: 'Score (short)',
    definition: "This row's short-side composite score, roughly 0-100+.",
  },
  crowded_long_score: {
    label: 'Score (crowded-long)',
    definition: "This row's crowded-long composite score, roughly 0-100+.",
  },
  squeeze_risk_score: {
    label: 'Score (squeeze-risk)',
    definition: "This row's squeeze-risk composite score, roughly 0-100+.",
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

/** A context chip whose definition/value come straight from a copy.ts lookup entry. */
function metaContextView(
  key: string,
  label: string,
  meta: { label: string; definition: string },
  tone: string,
): ReasonPartView {
  return { key, label, definition: meta.definition, value: meta.label, tone };
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
    if (part.label === 'Tape' && row.cvd_absorption_state) {
      return metaContextView(
        'context-tape',
        'Tape',
        lookupCvdAbsorptionState(row.cvd_absorption_state),
        tone,
      );
    }
    if (
      part.label === 'OI' &&
      (row.oi_price_trend_state === 'diverging_long' ||
        row.oi_price_trend_state === 'diverging_short')
    ) {
      return metaContextView(
        'context-oi-trend',
        'OI trend',
        lookupOiPriceTrendState(row.oi_price_trend_state),
        tone,
      );
    }
    if (part.label === 'RSI divergence' && row.technical_state.technical_divergence) {
      return metaContextView(
        'context-divergence',
        'RSI divergence',
        lookupTechnicalDivergence(row.technical_state.technical_divergence),
        tone,
      );
    }
    if (part.label === 'Fresh EMA20/50 cross') {
      const direction = row.technical_state.ema_cross_direction;
      const bars = row.technical_state.ema_cross_bars_since;
      if ((direction === 'bullish' || direction === 'bearish') && bars != null) {
        return {
          key: 'context-ema-cross',
          label: 'Fresh EMA20/50 cross',
          definition: `EMA20 crossed EMA50 ${bars} bars ago (4h bars).`,
          value: direction === 'bullish' ? 'Bull' : 'Bear',
          tone,
        };
      }
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

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="detail-section border-t border-line pt-2.5">
      <summary className="label flex items-center gap-2.5 cursor-pointer list-none">
        {title}
      </summary>
      <div className="detail-section-body pt-2.5 grid gap-2">{children}</div>
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
  const qTone = qualityTone(row.quality);
  return (
    <div className="grid grid-cols-3 max-[900px]:grid-cols-2 max-[480px]:grid-cols-1 gap-x-6 gap-y-4">
      {row.score_field === null ? null : (
        <StatTile
          label={scoreFieldMeta(row.score_field).label}
          definition={scoreFieldMeta(row.score_field).definition}
          value={fmtNum(row.score)}
        />
      )}
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
      {(() => {
        // Explicit server null means "inside the noise dead-zone" -- distinct from no data at all
        // (oiPriceQuadrant() itself can't tell the two apart from a bare null return; see its doc).
        if (row.oi_price_quadrant === null) {
          return (
            <StatTile
              label={lookupMetric('oi_price_read').label}
              definition={lookupMetric('oi_price_read').definition}
              value="Quiet"
            />
          );
        }
        const q = oiPriceQuadrant(row);
        return q ? (
          <StatTile
            label={lookupMetric('oi_price_read').label}
            definition={lookupMetric('oi_price_read').definition}
            value={q.label}
            tone={q.tone}
          />
        ) : null;
      })()}
      <StatTile
        label={lookupMetric('funding').label}
        definition={lookupMetric('funding').definition}
        value={fmtPct(row.funding_rate_pct, 4)}
        tone={signTone(row.funding_rate_pct)}
      />
      <StatTile
        label={lookupMetric('liquidation_imbalance').label}
        definition={lookupMetric('liquidation_imbalance').definition}
        value={fmtPct(row.liquidation_imbalance_24h_pct)}
        tone={signTone(row.liquidation_imbalance_24h_pct)}
      />
      <StatTile
        label={lookupMetric('taker_flow').label}
        definition={lookupMetric('taker_flow').definition}
        value={fmtPct(row.taker_imbalance_24h_pct)}
        tone={signTone(row.taker_imbalance_24h_pct)}
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
      <StatTile
        label={lookupMetric('size_multiplier').label}
        definition={lookupMetric('size_multiplier').definition}
        value={
          row.scores.size_multiplier == null ? '-' : `${fmtNum(row.scores.size_multiplier, 2)}x`
        }
      />
      {row.btc_beta == null ? null : (
        <StatTile
          label={lookupMetric('btc_beta').label}
          definition={lookupMetric('btc_beta').definition}
          value={fmtNum(row.btc_beta, 2)}
        />
      )}
      {row.residual_change_24h_pct == null ? null : (
        <StatTile
          label={lookupMetric('residual_change_24h').label}
          definition={lookupMetric('residual_change_24h').definition}
          value={fmtPct(row.residual_change_24h_pct)}
          tone={signTone(row.residual_change_24h_pct)}
        />
      )}
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

  const positionRatio = row.top_trader_position_ratio;
  const positionDelta = row.top_trader_ratio_delta_24h;
  const deltaTone = signTone(positionDelta);

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
      {positionRatio == null && positionDelta == null ? null : (
        <div className="driver-line mt-1 flex items-center gap-1.5 flex-wrap">
          {positionRatio == null ? null : (
            <span className="inline-flex items-center gap-1 text-ink">
              <Term
                label="top pos"
                definition={lookupMetric('top_trader_position_ratio').definition}
              />
              {fmtNum(positionRatio, 2)}
            </span>
          )}
          {positionDelta == null ? null : (
            <span
              className={deltaTone === 'pos' ? 'text-up' : deltaTone === 'neg' ? 'text-down' : ''}
              title={lookupMetric('top_trader_ratio_delta_24h').definition}
            >
              Δ24h {positionDelta >= 0 ? '+' : ''}
              {fmtNum(positionDelta, 2)}
            </span>
          )}
        </div>
      )}
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
    <div className="grid grid-cols-2 max-[680px]:grid-cols-1 gap-x-6 gap-y-4 -mt-1">
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
      <StatTile
        label="Donchian position (20)"
        value={
          state.donchian_position_20 == null
            ? '-'
            : fmtPct(state.donchian_position_20 * 100, 2).replace('+', '')
        }
      />
      {state.breakout_pct_20 ? (
        <StatTile label="Breakout (20)" value={fmtPct(state.breakout_pct_20, 2)} tone="pos" />
      ) : null}
      {state.breakdown_pct_20 ? (
        <StatTile label="Breakdown (20)" value={fmtPct(state.breakdown_pct_20, 2)} tone="neg" />
      ) : null}
      <StatTile
        label="Volume vs avg (20)"
        value={
          state.breakout_volume_ratio_20 == null
            ? '-'
            : `${fmtNum(state.breakout_volume_ratio_20, 2)}x`
        }
      />
      {(() => {
        const cross = emaCrossLine(state);
        return cross ? <StatTile label="Trend shift" value={cross.text} tone={cross.tone} /> : null;
      })()}
      {(() => {
        const divergence = divergenceLine(state);
        return divergence ? (
          <StatTile label="RSI divergence" value={divergence} tone="warn" />
        ) : null;
      })()}
    </div>
  );
}

const GOLDEN_POCKET_DEFINITION =
  'Fib 0.5–0.618 retracement of the latest confirmed 4h swing leg. Computed on 4h closes — refine the exact leg on your own 1H/15M chart.';

function LevelsBlock({ row }: { row: DashboardRow }) {
  const state = row.technical_state;
  const gpUpper = state.golden_pocket_upper;
  const gpLower = state.golden_pocket_lower;
  const hasGoldenPocket = gpUpper != null && gpLower != null;
  const hasLevels =
    state.ema_20 != null ||
    state.ema_50 != null ||
    state.ema_200 != null ||
    state.donchian_high_20 != null ||
    state.donchian_low_20 != null ||
    hasGoldenPocket;
  if (!hasLevels) {
    return <div className="driver-line">No CoinGlass OHLC technical snapshot for this row.</div>;
  }
  const distance = state.distance_to_golden_pocket_pct;
  const inZone = distance != null && Math.abs(distance) === 0;
  // fmtPrice's null fallback ("Price unavailable") is copy written for the live price line up top
  // -- wrong for a computed level that's merely absent for this candle count. '-' matches how
  // every other level/metric tile already renders a missing value (fmtNum/fmtPct convention).
  const fmtLevel = (v: number | null | undefined) =>
    v === null || v === undefined ? '-' : fmtPrice(v);
  return (
    <div className="grid grid-cols-2 max-[680px]:grid-cols-1 gap-x-6 gap-y-4 -mt-1">
      <StatTile label="EMA 20" value={fmtLevel(state.ema_20)} />
      <StatTile label="EMA 50" value={fmtLevel(state.ema_50)} />
      <StatTile label="EMA 200" value={fmtLevel(state.ema_200)} />
      <StatTile label="Donchian 20 high" value={fmtLevel(state.donchian_high_20)} />
      <StatTile label="Donchian 20 low" value={fmtLevel(state.donchian_low_20)} />
      {hasGoldenPocket ? (
        <StatTile
          label="Golden pocket"
          definition={GOLDEN_POCKET_DEFINITION}
          value={
            <>
              <span>{`${fmtLevel(gpLower)} – ${fmtLevel(gpUpper)}`}</span>
              {state.fib_leg_direction ? (
                <div className="driver-line mt-1">
                  {state.fib_leg_direction === 'up'
                    ? 'pullback zone of the last up-leg'
                    : 'bounce zone of the last down-leg'}
                  {' · '}
                  {fmtPct(distance)}
                </div>
              ) : null}
            </>
          }
          tone={inZone ? 'pos' : undefined}
        />
      ) : null}
    </div>
  );
}

function HistoryBlock({ row }: { row: DashboardRow }) {
  if (row.history.length < 2) {
    return <div className="driver-line">More saved runs needed for multi-point trend lines.</div>;
  }
  const scoreField = scoreFieldOf(row);
  return (
    <div className="history-block">
      {scoreField === null ? null : (
        <HistoryLine label="Score" points={row.history} field={scoreField} />
      )}
      <HistoryLine label="OI 24h" points={row.history} field="oi_change_24h_pct" />
      <HistoryLine label="Funding" points={row.history} field="funding_rate_pct" />
      <HistoryLine label="RSI" points={row.history} field="rsi_14" />
    </div>
  );
}

type HistoryField =
  | 'long_score'
  | 'short_score'
  | 'crowded_long_score'
  | 'squeeze_risk_score'
  | 'oi_change_24h_pct'
  | 'funding_rate_pct'
  | 'rsi_14';

/** null for 'core' rows, which have no score_field -- HistoryBlock omits the Score line entirely then. */
function scoreFieldOf(row: DashboardRow): HistoryField | null {
  const field = row.score_field;
  if (
    field === 'long_score' ||
    field === 'short_score' ||
    field === 'crowded_long_score' ||
    field === 'squeeze_risk_score'
  ) {
    return field;
  }
  return null;
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
