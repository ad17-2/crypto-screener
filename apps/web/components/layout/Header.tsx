import type { Freshness, RunSummary } from '@crypto-screener/contracts';
import { lookupFreshness } from '@/lib/copy';
import type { RefreshStatusChip } from '@/lib/refresh-status';
import { parseRefreshStatus, refreshStatusChip } from '@/lib/refresh-status';
import { GuideDrawer } from './GuideDrawer';
import { ReloadButton } from './ReloadButton';
import { RunSelector } from './RunSelector';
import { ThemeToggle } from './ThemeToggle';

export interface HeaderProps {
  freshness: Freshness;
  runs: RunSummary[];
  selectedRunId?: string | undefined;
  refreshStatus?: unknown;
}

/**
 * The page order (Market -> Breadth & Rotation -> The Majors -> Screened coins) IS the
 * workflow.
 */
export function Header({ freshness, runs, selectedRunId, refreshStatus }: HeaderProps) {
  const chip = refreshStatusChip(parseRefreshStatus(refreshStatus));
  return (
    <div className="flex items-start justify-between gap-4 mb-10 max-[680px]:flex-col max-[680px]:items-start max-[680px]:gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="m-0 text-lg font-bold text-ink">Crypto Screener</h1>
        <FreshnessPill freshness={freshness} />
        <RefreshChip chip={chip} />
      </div>
      {/* Wraps rather than stretches: full-width stacked controls ate the whole fold on mobile. */}
      <div className="flex gap-2 items-center flex-wrap justify-end text-[13px] max-[680px]:justify-start">
        <GuideDrawer />
        <span className="text-ash" aria-hidden="true">
          ·
        </span>
        <RunSelector runs={runs} selectedRunId={selectedRunId} />
        <span className="text-ash" aria-hidden="true">
          ·
        </span>
        <ThemeToggle />
        <span className="text-ash" aria-hidden="true">
          ·
        </span>
        <ReloadButton />
      </div>
    </div>
  );
}

function RefreshChip({ chip }: { chip: RefreshStatusChip | null }) {
  if (chip === null) return null;
  const className = chip.tone === 'warn' ? 'setup-badge warn' : 'text-ash text-xs font-mono';
  return (
    <span className={className} title={chip.title ?? undefined}>
      {chip.text}
    </span>
  );
}

function FreshnessPill({ freshness }: { freshness: Freshness }) {
  const entry = lookupFreshness(freshness.label);
  const age = formatAge(freshness.age_minutes);
  return (
    <span className="inline-flex items-center gap-2 text-[12px]" title={entry.definition}>
      <span className="live-dot" aria-hidden="true" />
      <span className="text-ink font-semibold">{entry.label}</span>
      {age ? <span className="text-ash">Updated {age}</span> : null}
    </span>
  );
}

function formatAge(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
