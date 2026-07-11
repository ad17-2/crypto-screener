import type { RunSummary } from '@crypto-screener/contracts';
import { ReloadButton } from './ReloadButton';
import { RunSelector } from './RunSelector';
import { ThemeToggle } from './ThemeToggle';

export interface HeaderProps {
  subtitle: string;
  runs: RunSummary[];
  selectedRunId?: string | undefined;
}

export function Header({ subtitle, runs, selectedRunId }: HeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-[18px] max-[680px]:flex-col max-[680px]:items-stretch">
      <div>
        <h1 className="m-0 text-base font-semibold uppercase tracking-wide leading-tight">
          Crypto Dashboard
        </h1>
        <div className="text-muted text-[13px] mt-1.5">{subtitle}</div>
      </div>
      <div className="flex gap-2 items-center flex-wrap justify-end max-[680px]:justify-stretch">
        <RunSelector runs={runs} selectedRunId={selectedRunId} />
        <ThemeToggle />
        <ReloadButton />
      </div>
    </div>
  );
}
