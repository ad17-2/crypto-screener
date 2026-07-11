import { lookupQualityFlag } from '@/lib/copy';

export function QualityFlagChip({ flag }: { flag: string }) {
  const entry = lookupQualityFlag(flag);
  const tone =
    flag.includes('extreme') || flag.includes('invalid') || flag.includes('deviates')
      ? 'bad'
      : 'warn';
  return (
    <span className={`quality-flag-chip ${tone}`} title={entry.definition}>
      {entry.label}
      {entry.detail ? <strong> {entry.detail}</strong> : null}
    </span>
  );
}
