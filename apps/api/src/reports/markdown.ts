import type { AppConfig } from '../config/index.js';
import {
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
  topBy,
} from '../dashboard/watchlists.js';
import { formatSigned, reasonFor } from '../pipeline/factorExplanations.js';
import type { RunPayload } from '../pipeline/models.js';
import { toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';
import { asArray, asRecord } from '../pipeline/types.js';
import { formatPct, formatUsd } from './format.js';

/** Fallback applies only when `key` is absent, not when its value is explicit `null`. */
function get(record: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in record ? record[key] : fallback;
}

/** Renders null as 'None', booleans as 'True'/'False' -- not JS's default `String()` output. */
function pyStr(value: unknown): string {
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

export function renderMarkdown(payload: RunPayload, config: AppConfig): string {
  const rows = payload.rows ?? [];
  const reportCfg = config.report;
  const limit = reportCfg.limit;
  const regime = payload.regime ?? {};
  const context = payload.market_context ?? {};
  const providerStatus = payload.provider_status ?? {};
  const weights = payload.factor_weights ?? {};

  const longRows = topBy(rows, 'long_score', limit, { predicate: isLongCandidate });
  const shortRows = topBy(rows, 'short_score', limit, { predicate: isShortCandidate });
  const fadeRows = topBy(rows, 'crowded_long_score', limit, { predicate: isCrowdedLong });
  const squeezeRows = topBy(rows, 'squeeze_risk_score', limit, { predicate: isCrowdedShort });
  const coreSymbols = new Set(reportCfg.core_symbols);
  const coreRows = rows.filter(
    (row) => typeof row.symbol === 'string' && coreSymbols.has(row.symbol),
  );

  return [
    '# Crypto Quant Daily Report',
    '',
    `Generated: \`${payload.generated_at}\``,
    '',
    'Signal-only report. It ranks symbols for manual chart review and never places trades.',
    '',
    '## Market Bias',
    marketBiasBlock(regime, context),
    '',
    '## Provider Status',
    providerStatusBlock(providerStatus),
    '',
    '## Data Quality',
    dataQualityBlock(rows),
    '',
    '## Factor Regime',
    factorWeightsTable(weights),
    '',
    '## Dominance And Sector Rotation',
    rotationBlock(context),
    '',
    '## BTC / ETH / SOL Core Read',
    candidateTable(coreRows, 'factor_score', 'long'),
    '',
    '## Top Long Watchlist',
    candidateTable(longRows, 'long_score', 'long'),
    '',
    '## Top Short Watchlist',
    candidateTable(shortRows, 'short_score', 'short'),
    '',
    '## Crowded Longs To Fade',
    candidateTable(fadeRows, 'crowded_long_score', 'fade-long'),
    '',
    '## Crowded Shorts / Squeeze Risk',
    candidateTable(squeezeRows, 'squeeze_risk_score', 'squeeze-risk'),
    '',
    '## Manual Chart Checklist',
    '- Confirm higher-timeframe trend and current key level.',
    '- Reject late entries where price is extended far from invalidation.',
    '- Treat extreme funding and long/short crowding as risk, not an entry by itself.',
    '- Prefer setups where factor direction, liquidity, sector context, and BTC regime agree.',
    '- If BTC regime conflicts with the alt setup, size down or skip.',
    '',
  ].join('\n');
}

function marketBiasBlock(
  regime: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  const lines = [
    `- Bias: \`${pyStr(get(regime, 'bias', 'unknown'))}\``,
    `- Factor regime: \`${pyStr(get(regime, 'label', 'unknown'))}\``,
    `- Bias score: \`${pyStr(get(regime, 'bias_score', '-'))}\``,
    `- Total crypto market cap: \`${formatUsd(context.total_market_cap_usd)}\``,
    `- Market cap 24h: \`${formatPct(context.market_cap_change_24h_pct)}\``,
    `- BTC dominance: \`${formatPct(context.btc_dominance_pct, 2, false)}\``,
    `- ETH dominance: \`${formatPct(context.eth_dominance_pct, 2, false)}\``,
    `- Avg futures funding: \`${formatPct(regime.avg_funding_rate_pct, 4)}\``,
    `- Breadth: \`${pyStr(get(regime, 'breadth_label', 'unknown'))}\` (\`${pyStr(get(regime, 'breadth_score', '-'))}\`)`,
    `- Sector rotation: \`${pyStr(get(regime, 'sector_rotation_label', 'unknown'))}\``,
  ];
  return lines.join('\n');
}

function providerStatusBlock(providerStatus: Record<string, unknown>): string {
  const entries = Object.entries(providerStatus);
  if (entries.length === 0) {
    return '_No provider status._';
  }
  const lines = ['| Provider | Status | Rows | Note |', '|---|---|---:|---|'];
  for (const [provider, rawDetails] of entries) {
    const details = asRecord(rawDetails);
    const note = stringOrDash(details.reason, details.note).replace(/\|/g, '/');
    lines.push(
      `| ${provider} | ${pyStr(get(details, 'status', '-'))} | ${pyStr(get(details, 'rows', '-'))} | ${note} |`,
    );
  }
  return lines.join('\n');
}

function stringOrDash(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return '-';
}

function factorWeightsTable(weights: Record<string, unknown>): string {
  const stats = asRecord(get(weights, 'stats', {}));
  const statEntries = Object.entries(stats);
  if (statEntries.length === 0) {
    return '_No factor weights._';
  }
  const lines = [
    `History records: \`${pyStr(get(weights, 'history_records', 0))}\`. Weight mode: \`${pyStr(get(weights, 'mode', 'prior'))}\`.`,
    validationSummary(asRecord(get(weights, 'validation', {}))),
    '',
    '| Factor | Weight | IC | Obs | Mode |',
    '|---|---:|---:|---:|---|',
  ];
  const sorted = [...statEntries].sort(
    (a, b) => Math.abs(weightOf(b[1])) - Math.abs(weightOf(a[1])),
  );
  for (const [factor, rawDetails] of sorted) {
    const details = asRecord(rawDetails);
    const ic = get(details, 'ic', null);
    const icText = ic === null ? '-' : formatSigned(toFloat(ic) ?? 0, 3);
    lines.push(
      `| ${factor} | ${formatSigned(weightOf(details), 3)} | ${icText} | ${pyStr(get(details, 'observations', 0))} | ${pyStr(get(details, 'mode', '-'))} |`,
    );
  }
  return lines.join('\n');
}

function weightOf(details: unknown): number {
  const value = get(asRecord(details), 'weight', 0.0);
  return typeof value === 'number' ? value : 0.0;
}

function rotationBlock(context: Record<string, unknown>): string {
  const categories = asRecord(get(context, 'categories', {}));
  const breadth = asRecord(get(context, 'breadth', {}));
  const sectorRotation = asRecord(get(context, 'sector_rotation', {}));
  const leaders = asArray(get(categories, 'leaders', [])).slice(0, 5);
  const laggards = asArray(get(categories, 'laggards', [])).slice(0, 5);
  if (leaders.length === 0 && laggards.length === 0 && Object.keys(breadth).length === 0) {
    return '_No category data available._';
  }

  const lines = [
    `Market breadth: \`${pyStr(get(breadth, 'label', 'unknown'))}\` score \`${pyStr(get(breadth, 'score', '-'))}\`, advancers \`${pyStr(get(breadth, 'advancer_pct', '-'))}%\`.`,
    `Sector tape: \`${pyStr(get(sectorRotation, 'label', 'unknown'))}\`.`,
    '',
    'Top category leaders:',
    ...categoryLines(leaders),
    '',
    'Top category laggards:',
    ...categoryLines(laggards),
  ];
  return lines.join('\n');
}

function categoryLines(categories: unknown[]): string[] {
  if (categories.length === 0) {
    return ['- none'];
  }
  return categories.map((raw) => {
    const item = asRecord(raw);
    const idFallback = get(item, 'id', '-');
    const name = get(item, 'name', idFallback);
    return `- ${pyStr(name)}: ${formatPct(item.market_cap_change_24h_pct)}, volume ${formatUsd(item.volume_24h_usd)}`;
  });
}

function validationSummary(validation: Record<string, unknown>): string {
  if (Object.keys(validation).length === 0) {
    return 'Validation: `unavailable`.';
  }
  const model = asRecord(get(validation, 'model', {}));
  const hitRateNumeric = toFloat(model.hit_rate);
  const hitText = hitRateNumeric === null ? '-' : `${hitRateNumeric.toFixed(2)}%`;
  const status = pyStr(get(validation, 'status', 'unknown'));
  const observations = pyStr(get(validation, 'observations', 0));
  const horizon = pyStr(get(validation, 'horizon_hours', '-'));
  return `Validation: \`${status}\`, observations \`${observations}\`, horizon \`${horizon}h\`, model hit rate \`${hitText}\`.`;
}

function candidateTable(rows: Row[], scoreField: string, side: string): string {
  if (rows.length === 0) {
    return '_No matches._';
  }
  const lines = [
    '| Symbol | Score | Conf | Quality | Tech | 24h | OI 24h | Funding | L/S | Volume | Source | Reason |',
    '|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---|',
  ];
  for (const row of rows) {
    const scoreRaw = row[scoreField];
    const score = typeof scoreRaw === 'number' && scoreRaw !== 0 ? scoreRaw : 0.0;
    const symbol = pyStr(get(row, 'symbol', '-'));
    const confidenceRaw = get(row, 'confidence_score', null);
    const confidence = confidenceRaw === null ? '-' : (toFloat(confidenceRaw) ?? 0).toFixed(0);
    const quality = pyStr(get(row, 'data_quality_score', 100));
    const techRaw = row.technical_setup;
    const tech = (typeof techRaw === 'string' && techRaw !== '' ? techRaw : '-').replace(
      /\|/g,
      '/',
    );
    const price = formatPct(row.price_change_24h_pct);
    const oi = formatPct(row.oi_change_24h_pct);
    const funding = formatPct(row.funding_rate_pct, 4);
    const lsRaw = get(row, 'long_short_ratio', null);
    const ls = lsRaw === null ? '-' : (toFloat(lsRaw) ?? 0).toFixed(2);
    const volume = formatUsd(row.quote_volume_usd);
    const source = pyStr(get(row, 'data_source', '-'));
    const reason = reasonFor(row, side).replace(/\|/g, '/');
    lines.push(
      `| ${symbol} | ${score.toFixed(2)} | ${confidence} | ${quality} | ${tech} | ${price} | ${oi} | ${funding} | ${ls} | ${volume} | ${source} | ${reason} |`,
    );
  }
  return lines.join('\n');
}

function dataQualityBlock(rows: Row[]): string {
  const flagged = rows.filter((row) => {
    const flags = row.data_quality_flags;
    return Array.isArray(flags) && flags.length > 0;
  });
  const trusted = rows.filter((row) => row.is_trusted !== false).length;
  const excluded = rows.length - trusted;
  const lines = [
    `- Trusted rows used for ranking: \`${trusted}\``,
    `- Excluded rows: \`${excluded}\``,
  ];
  if (flagged.length === 0) {
    return lines.join('\n');
  }

  lines.push('', '| Symbol | Source | 24h | OI 24h | Flags |', '|---|---|---:|---:|---|');
  for (const row of flagged.slice(0, 12)) {
    const flags = Array.isArray(row.data_quality_flags) ? row.data_quality_flags : [];
    const flagsText = flags
      .map((flag) => pyStr(flag))
      .join(', ')
      .replace(/\|/g, '/');
    lines.push(
      `| ${pyStr(get(row, 'symbol', '-'))} | ${pyStr(get(row, 'data_source', '-'))} | ${formatPct(row.price_change_24h_pct)} | ${formatPct(row.oi_change_24h_pct)} | ${flagsText} |`,
    );
  }
  if (flagged.length > 12) {
    lines.push(`| ... | ... | ... | ... | ${flagged.length - 12} more excluded rows |`);
  }
  return lines.join('\n');
}
