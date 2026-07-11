'use client';

import type { RunSummary } from '@crypto-screener/contracts';
import { useRouter } from 'next/navigation';

export interface RunSelectorProps {
  runs: RunSummary[];
  selectedRunId?: string | undefined;
}

/** Navigates to ?run=<run_id>, which re-runs the server component's getDashboard(runId). */
export function RunSelector({ runs, selectedRunId }: RunSelectorProps) {
  const router = useRouter();

  if (runs.length === 0) {
    return null;
  }

  return (
    <select
      aria-label="Run"
      value={selectedRunId ?? runs[0]?.run_id}
      onChange={(event) => router.push(`/?run=${encodeURIComponent(event.target.value)}`)}
      className="h-9 border border-line bg-panel text-ink rounded-md px-2.5 text-[13px] max-w-[220px]"
    >
      {runs.map((run) => (
        <option key={run.run_id} value={run.run_id}>
          {run.generated_at}
        </option>
      ))}
    </select>
  );
}
