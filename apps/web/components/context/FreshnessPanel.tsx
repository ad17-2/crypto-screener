import type { Freshness, RunSummary } from '@crypto-screener/contracts';
import { Panel } from '@/components/layout/Panel';
import { fmtNum } from '@/lib/format';
import { Row } from './Row';

export interface FreshnessPanelProps {
  freshness: Freshness;
  runs: RunSummary[];
}

export function FreshnessPanel({ freshness, runs }: FreshnessPanelProps) {
  const meta = freshness.label || `${runs.length} loaded`;

  return (
    <Panel title="Freshness / Runs" meta={meta} accent="blue">
      <p className="px-3 pt-2.5 text-muted text-xs leading-snug">
        When the selected run was generated and how old it is, plus a history of recent runs and
        their status.
      </p>
      <FreshnessBlock freshness={freshness} />
      <RunsBlock runs={runs} />
    </Panel>
  );
}

function FreshnessBlock({ freshness }: { freshness: Freshness }) {
  if (freshness.status !== 'ok') {
    return (
      <div className="list p-3 grid gap-2">
        <Row label="Freshness" value="unknown" />
      </div>
    );
  }
  return (
    <div className="list freshness-list p-3 grid gap-2 border-b border-line">
      <Row label="Selected Run" value={freshness.generated_at || '-'} />
      <Row
        label="Age"
        value={`${freshness.label || 'unknown'} / ${fmtNum(freshness.age_minutes, 1)}m`}
      />
    </div>
  );
}

function RunsBlock({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return <div className="py-7 px-3 text-muted text-center">No runs</div>;
  }
  return (
    <div className="list p-3 grid gap-2">
      {runs.slice(0, 12).map((run) => (
        <Row
          key={run.run_id}
          label={run.generated_at}
          value={`${run.bias} / ${run.coinglass_status} / ${run.row_count} rows`}
        />
      ))}
    </div>
  );
}
