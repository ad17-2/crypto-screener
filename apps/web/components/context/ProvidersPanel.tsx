import { Panel } from '@/components/layout/Panel';
import { asProviderEntry, providerTone } from '@/lib/provider-status';

export interface ProvidersPanelProps {
  /** untyped on the wire — read defensively. */
  providerStatus: Record<string, unknown>;
}

export function ProvidersPanel({ providerStatus }: ProvidersPanelProps) {
  const entries = Object.entries(providerStatus);
  const hasIssue = entries.some(([, raw]) => asProviderEntry(raw).status !== 'ok');
  const meta = hasIssue ? 'needs attention' : `${entries.length} ok`;

  return (
    <Panel title="Providers" meta={meta} accent="blue">
      {entries.length === 0 ? (
        <div className="py-7 px-3 text-muted text-center">No providers</div>
      ) : (
        <div className="provider-list p-3 grid gap-2">
          {entries.map(([name, raw]) => {
            const details = asProviderEntry(raw);
            return (
              <div
                key={name}
                className="provider-row grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 items-center min-h-[30px] text-[13px]"
              >
                <strong>{name}</strong>
                <span className={`status-pill ${providerTone(details.status)}`}>
                  {details.status}
                </span>
                <span className="provider-count text-muted text-xs font-mono text-right min-w-[38px]">
                  {details.rows === undefined ? '-' : details.rows}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
