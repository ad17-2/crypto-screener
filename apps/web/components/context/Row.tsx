import type { ReactNode } from 'react';

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="list-row flex justify-between gap-3 text-[13px]">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}
