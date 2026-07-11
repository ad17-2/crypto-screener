export interface ProviderEntry {
  status: string;
  rows?: number | undefined;
}

export function asProviderEntry(value: unknown): ProviderEntry {
  if (typeof value !== 'object' || value === null) {
    return { status: '-' };
  }
  const record = value as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : '-',
    rows: typeof record.rows === 'number' ? record.rows : undefined,
  };
}

export function providerTone(status: string): '' | 'warn' | 'bad' {
  if (status === 'ok') return '';
  if (status === 'skipped' || status === 'disabled') return 'warn';
  return 'bad';
}
