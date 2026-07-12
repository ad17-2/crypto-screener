import type { Freshness, RunSummary } from '@crypto-screener/contracts';
import Link from 'next/link';
import { lookupFreshness } from '@/lib/copy';
import { ReloadButton } from './ReloadButton';
import { RunSelector } from './RunSelector';
import { ThemeToggle } from './ThemeToggle';

export interface HeaderProps {
  freshness: Freshness;
  runs: RunSummary[];
  selectedRunId?: string | undefined;
}

/**
 * The page order (Market -> Breadth & Rotation -> The Majors -> Screened coins) IS the
 * workflow.
 */
export function Header({ freshness, runs, selectedRunId }: HeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-[18px] max-[680px]:flex-col max-[680px]:items-start">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="m-0 text-base font-semibold uppercase tracking-wide leading-tight">
          Crypto Screener
        </h1>
        <FreshnessPill freshness={freshness} />
      </div>
      {/* Wraps rather than stretches: full-width stacked controls ate the whole fold on mobile. */}
      <div className="flex gap-2 items-center flex-wrap justify-end max-[680px]:justify-start">
        <Link href="/model" className="text-muted text-[13px] whitespace-nowrap hover:text-ink">
          Model health
        </Link>
        <RunSelector runs={runs} selectedRunId={selectedRunId} />
        <ThemeToggle />
        <ReloadButton />
      </div>
    </div>
  );
}

function FreshnessPill({ freshness }: { freshness: Freshness }) {
  const entry = lookupFreshness(freshness.label);
  const age = formatAge(freshness.age_minutes);
  return (
    <span
      className="inline-flex items-center gap-2 h-7 px-3 border border-line bg-panel rounded-full text-[12px]"
      title={entry.definition}
    >
      <span className="live-dot" aria-hidden="true" />
      <span className="text-ink font-semibold">{entry.label}</span>
      {age ? <span className="text-muted">Updated {age}</span> : null}
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
