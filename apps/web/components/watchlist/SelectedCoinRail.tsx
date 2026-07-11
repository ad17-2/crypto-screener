import type { DashboardRow } from '@crypto-screener/contracts';
import type { ReactNode } from 'react';
import { Panel } from '@/components/layout/Panel';
import { QualityFlagChip } from '@/components/QualityFlagChip';
import { positioningDivergence, tradingViewUrl } from '@/lib/dashboard-row';
import {
  clsFor,
  conflictTone,
  confluenceToneClass,
  fmtNum,
  fmtPct,
  fmtUsd,
  numeric,
  qualityTone,
} from '@/lib/format';

export interface SelectedCoinRailProps {
  row: DashboardRow | null;
}

const REASON_TOOLTIP =
  'Read left to right: 24h price move, OI positioning change, funding, L/S crowding, weighted factor score, confidence, 4h technical context, then the strongest normalized factor drivers. Green is positive, red is negative. Crowding and excluded notes are context flags, not automatic trade instructions.';

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
    <Panel title="Selected Coin" meta={row.setup || ''} aria-label="Selected coin detail">
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
            <div className="driver-line">
              {row.primary_driver?.label || 'No dominant driver'} / {row.side || '-'}
            </div>
          </div>
          <div className="detail-actions flex gap-1.5 flex-wrap justify-end">
            <a
              className="detail-link inline-flex items-center h-7 border border-line rounded-md px-2 text-blue no-underline text-xs font-bold"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              TradingView
            </a>
          </div>
        </div>

        <div className="detail-badges flex flex-wrap gap-1.5">
          <span className={`setup-badge ${row.setup_tone || 'neutral'}`}>
            {row.setup || 'Watchlist'}
          </span>
          <span className={`conflict-badge ${conflictTone(row.signal_conflict_label)}`}>
            {row.signal_conflict_label || 'unknown'}
          </span>
        </div>

        <ConfluenceStrip row={row} />

        <div className="detail-grid grid grid-cols-2 max-[680px]:grid-cols-1 gap-2">
          <DetailMetric
            label="Score / Priority"
            value={`${fmtNum(row.score)} / ${fmtNum(row.priority)}`}
          />
          <DetailMetric
            label="Confidence"
            value={row.confidence_score == null ? '-' : fmtNum(row.confidence_score, 0)}
          />
          <DetailMetric
            label="Quality"
            value={row.quality ?? '-'}
            valueClassName={qualityValueClass(row.quality)}
          />
          <DetailMetric
            label="24h / OI"
            value={
              <>
                <span className={clsFor(row.price_change_24h_pct)}>
                  {fmtPct(row.price_change_24h_pct)}
                </span>
                {' / '}
                <span className={clsFor(row.oi_change_24h_pct)}>
                  {fmtPct(row.oi_change_24h_pct)}
                </span>
              </>
            }
          />
          <DetailMetric
            label="Funding / L/S"
            value={
              <>
                <span className={clsFor(row.funding_rate_pct)}>
                  {fmtPct(row.funding_rate_pct, 4)}
                </span>
                {' / '}
                {row.long_short_ratio == null ? '-' : fmtNum(row.long_short_ratio)}
              </>
            }
          />
          <DetailMetric label="Positioning (R / T)" value={<PositioningValue row={row} />} />
          <DetailMetric label="Volume" value={fmtUsd(row.quote_volume_usd)} />
          <DetailMetric label="Open Interest" value={fmtUsd(row.open_interest_usd)} />
        </div>

        <div className="label">
          Reason{' '}
          <button
            type="button"
            className="help-tip"
            aria-label={REASON_TOOLTIP}
            title={REASON_TOOLTIP}
          >
            ?
          </button>
        </div>
        <ReasonStack row={row} />

        <DetailSection title="How To Read This Coin">
          <ExplanationBlock row={row} />
        </DetailSection>
        <DetailSection title="Signal Conflict" open={conflicts.length > 0}>
          <ConflictBlock row={row} />
        </DetailSection>
        <DetailSection title="Technical Context">
          <TechnicalBlock row={row} />
        </DetailSection>
        <DetailSection title="Factor Breakdown">
          <FactorBars row={row} />
        </DetailSection>
        <DetailSection title="History">
          <HistoryBlock row={row} />
        </DetailSection>

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

function qualityValueClass(quality: number | null | undefined): string {
  const tone = qualityTone(quality);
  if (tone === 'bad') return 'text-down';
  if (tone === 'warn') return 'text-warn';
  return '';
}

function DetailSection({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className="detail-section border-2 border-line rounded-md bg-panel-2 overflow-hidden border-l-gold"
      open={open}
    >
      <summary className="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer list-none text-ink text-xs font-semibold uppercase tracking-wide">
        {title}
      </summary>
      <div className="detail-section-body px-2.5 pb-2.5 grid gap-2">{children}</div>
    </details>
  );
}

function DetailMetric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="detail-metric min-w-0 border border-line rounded-md p-2 bg-panel-2">
      <span className="label">{label}</span>
      <strong className={valueClassName}>{value}</strong>
    </div>
  );
}

function PositioningValue({ row }: { row: DashboardRow }) {
  const retail = row.long_short_account_ratio;
  const top = row.top_trader_long_short_ratio;
  const divergence = positioningDivergence(row);
  const valueText = `${retail == null ? '-' : fmtNum(retail)}x / ${top == null ? '-' : fmtNum(top)}x`;
  const badgeTone = divergence
    ? divergence.tone === 'warn'
      ? 'warn'
      : divergence.tone === 'pos'
        ? 'pos'
        : 'neutral'
    : 'neutral';
  return (
    <>
      {valueText}
      {retail != null && top != null ? (
        <span className={`conflict-badge ${badgeTone}`}>
          {divergence ? divergence.label : 'n/a'}
        </span>
      ) : null}
    </>
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
        {conf.families.map((family) => (
          <span
            key={family.key}
            className={`conf-strip-cell ${confluenceToneClass(family.tone)}`}
            title={`${family.label}${family.value == null ? '' : ` (${family.value})`}`}
          >
            {family.label.split(' / ')[0]}
          </span>
        ))}
      </div>
    </div>
  );
}

function ReasonStack({ row }: { row: DashboardRow }) {
  const parts =
    row.reason_parts.length > 0
      ? row.reason_parts
      : row.reason
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => ({
            label: 'Note',
            value: part,
            tone: 'neutral',
            kind: 'metric',
            help: '',
          }));

  if (!parts.length) return <>-</>;

  const percentileByLabel: Record<string, number | null | undefined> = {
    Funding: row.funding_percentile,
    'OI 24h': row.oi_change_percentile,
    'L/S': row.positioning_percentile,
  };

  return (
    <div className="reason-stack" title={row.reason}>
      {parts.map((part) => {
        const pct = percentileByLabel[part.label];
        return (
          <span
            key={`${part.kind}-${part.label}-${part.value}`}
            className={`reason-part ${part.kind || 'metric'} ${part.tone || 'neutral'}`}
            title={part.help || ''}
          >
            <span>{part.label}</span>
            <strong>{part.value}</strong>
            {pct == null ? null : <span className="reason-pct">{Math.round(pct)}th pct</span>}
          </span>
        );
      })}
    </div>
  );
}

function ExplanationBlock({ row }: { row: DashboardRow }) {
  const explanation = row.explanation;
  const confirm = explanation.confirm;
  const risk = explanation.risk;
  if (!explanation.read && !confirm.length && !risk.length) {
    return <div className="driver-line">No token explanation available.</div>;
  }
  return (
    <div className="explanation-box">
      {explanation.read ? <p>{explanation.read}</p> : null}
      <div className="explanation-grid">
        <div>
          <div className="label">Confirm</div>
          {confirm.length ? (
            <ul className="explanation-list">
              {confirm.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div>
          <div className="label">Risk</div>
          {risk.length ? (
            <ul className="explanation-list risk">
              {risk.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConflictBlock({ row }: { row: DashboardRow }) {
  const conflicts = row.signal_conflicts;
  if (!conflicts.length) {
    return (
      <div className="conflict-summary">
        <span className={`conflict-badge ${conflictTone(row.signal_conflict_label)}`}>
          {row.signal_conflict_label || 'unknown'}
        </span>
        <span>No material conflict detected.</span>
      </div>
    );
  }
  return (
    <div className="conflict-block">
      <div className="conflict-summary">
        <span className={`conflict-badge ${conflictTone(row.signal_conflict_label)}`}>
          {row.signal_conflict_label || 'unknown'}
        </span>
        <span>Score {fmtNum(row.signal_conflict_score, 0)}</span>
      </div>
      {conflicts.map((item) => (
        <div key={item.code} className="conflict-row">
          <strong>{item.label || item.code || 'Conflict'}</strong>
          <span>{item.detail || `severity ${fmtNum(item.severity, 2)}`}</span>
        </div>
      ))}
    </div>
  );
}

function TechnicalBlock({ row }: { row: DashboardRow }) {
  const state = row.technical_state;
  if (Object.keys(state).length === 0 && !row.technical_setup) {
    return <div className="driver-line">No CoinGlass OHLC technical snapshot for this row.</div>;
  }
  return (
    <div className="detail-grid tech-grid grid grid-cols-2 max-[680px]:grid-cols-1 gap-2 -mt-1">
      <DetailMetric label="4h Setup" value={row.technical_setup || '-'} />
      <DetailMetric
        label="RSI / MACD"
        value={
          <>
            {fmtNum(state.rsi_14, 1)} /{' '}
            <span className={clsFor(state.macd_histogram_pct)}>
              {fmtPct(state.macd_histogram_pct, 3)}
            </span>
          </>
        }
      />
      <DetailMetric
        label="ATR / BB Width"
        value={`${fmtPct(state.atr_14_pct, 2)} / ${fmtPct(state.bb_width_pct, 2).replace('+', '')}`}
      />
      <DetailMetric
        label="BB Pos / EMA20 Dist"
        value={
          <>
            {fmtNum(state.bb_position, 2)} /{' '}
            <span className={clsFor(state.distance_ema20_pct)}>
              {fmtPct(state.distance_ema20_pct, 2)}
            </span>
          </>
        }
      />
      <DetailMetric
        label="Trend / Momentum"
        value={
          <>
            <span className={clsFor(state.technical_trend_score)}>
              {fmtNum(state.technical_trend_score, 2)}
            </span>
            {' / '}
            <span className={clsFor(state.technical_momentum_score)}>
              {fmtNum(state.technical_momentum_score, 2)}
            </span>
          </>
        }
      />
      <DetailMetric
        label="Candles"
        value={`${state.technical_candle_count ?? '-'} ${state.technical_interval || ''}`}
      />
    </div>
  );
}

function FactorBars({ row }: { row: DashboardRow }) {
  const parts = row.factor_parts;
  if (!parts.length) return <div className="py-7 px-3 text-muted text-center">No factor data</div>;
  const maxAbs = Math.max(...parts.map((part) => Math.abs(Number(part.value || 0))), 1);
  return (
    <div className="factor-list grid gap-2">
      {parts.map((part) => {
        const width = Math.round((Math.abs(Number(part.value || 0)) / maxAbs) * 100);
        return (
          <div
            key={part.name}
            className="factor-row grid grid-cols-[minmax(90px,1fr)_minmax(0,1.2fr)_48px] gap-2 items-center text-xs"
          >
            <span>{part.label}</span>
            <span className="factor-track">
              <span
                className={`factor-fill ${part.tone || 'neutral'}`}
                style={{ width: `${width}%` }}
              />
            </span>
            <strong className={part.value > 0 ? 'text-up' : part.value < 0 ? 'text-down' : ''}>
              {fmtNum(part.value, 2)}
            </strong>
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
  const tone = lastValue > firstValue ? 'good' : lastValue < firstValue ? 'bad' : 'neutral';

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
