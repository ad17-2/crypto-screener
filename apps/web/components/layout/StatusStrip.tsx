import type { Freshness, Quality } from '@crypto-screener/contracts';
import type { ReactNode } from 'react';
import { clsFor, fmtPct } from '@/lib/format';
import { asProviderEntry, providerTone } from '@/lib/provider-status';

export interface StatusStripProps {
  freshness: Freshness;
  quality: Quality;
  /** untyped on the wire — read defensively. */
  regime: Record<string, unknown>;
  /** untyped on the wire — read defensively. */
  marketContext: Record<string, unknown>;
  /** untyped on the wire, one entry per provider (coingecko, coinglass, ...) — read defensively. */
  providerStatus: Record<string, unknown>;
}

export function StatusStrip({
  freshness,
  quality,
  regime,
  marketContext,
  providerStatus,
}: StatusStripProps) {
  const excludedTone = quality.excluded_count ? 'text-warn' : 'text-up';

  return (
    <div
      role="status"
      aria-label="Market pulse"
      className="col-span-full flex flex-wrap items-center gap-y-1.5 py-[11px] px-3.5 bg-panel border border-line rounded-md mb-3"
    >
      <LivePill freshness={freshness} />
      <Segment label="Bias" value={asString(regime.bias) ?? 'unknown'} valueClassName="text-gold" />
      <Segment label="Regime" value={asString(regime.label) ?? 'unknown'} />
      <Segment
        label="MC 24h"
        value={fmtPct(marketContext.market_cap_change_24h_pct)}
        valueClassName={clsFor(marketContext.market_cap_change_24h_pct)}
      />
      <Segment label="BTC.D" value={fmtPct(marketContext.btc_dominance_pct, 2).replace('+', '')} />
      <Segment
        label="BTC.D Δ"
        value={fmtPct(marketContext.btc_dominance_delta_pct)}
        valueClassName={clsFor(marketContext.btc_dominance_delta_pct)}
      />
      <Segment
        label="ETH/BTC"
        value={fmtPct(marketContext.eth_btc_performance_pct)}
        valueClassName={clsFor(marketContext.eth_btc_performance_pct)}
      />
      <Segment
        label="Trusted / Excl"
        value={`${quality.trusted_count} / ${quality.excluded_count}`}
        valueClassName={excludedTone}
      />
      <Segment label="Providers" value={<ProviderDots providers={providerStatus} />} />
    </div>
  );
}

function LivePill({ freshness }: { freshness: Freshness }) {
  return (
    <span className="tape-live inline-flex items-center gap-2 pr-4 mr-0.5 border-r border-line">
      <span className="live-dot" />
      <b className="text-[11px] font-extrabold tracking-wider uppercase text-up">Live</b>
      <span className="font-mono tabular-nums text-xs text-muted">{tapeAge(freshness)}</span>
    </span>
  );
}

function Segment({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <span className="tape-seg inline-flex items-baseline gap-1.5 px-4 border-l border-line">
      <span className="text-[10px] font-bold tracking-wider uppercase text-muted">{label}</span>
      <span
        className={`font-mono tabular-nums text-[13px] font-bold ${valueClassName ?? 'text-ink'}`}
      >
        {value}
      </span>
    </span>
  );
}

function ProviderDots({ providers }: { providers: Record<string, unknown> }) {
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    return <>-</>;
  }
  return (
    <span className="provider-dots">
      {entries.map(([name, raw]) => {
        const details = asProviderEntry(raw);
        const title =
          details.rows === undefined ? details.status : `${details.status} / ${details.rows} rows`;
        return (
          <span key={name} className={`provider-dot ${providerTone(details.status)}`} title={title}>
            {name}
          </span>
        );
      })}
    </span>
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tapeAge(freshness: Freshness): string {
  if (freshness.status !== 'ok') return 'unknown';
  if (freshness.age_minutes != null && Number.isFinite(freshness.age_minutes)) {
    return `${freshness.age_minutes.toFixed(0)}m ago`;
  }
  return freshness.label || 'unknown';
}
