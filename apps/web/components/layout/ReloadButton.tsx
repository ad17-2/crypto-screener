'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { triggerRefresh } from '@/lib/actions';

/**
 * router.refresh() re-renders once the refresh is acknowledged, but /api/refresh only returns a
 * 202 — the pipeline run is async, so rows won't update instantly.
 */
export function ReloadButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await triggerRefresh();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1 max-[680px]:w-full">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="h-9 border border-line bg-panel text-ink rounded-md px-2.5 text-[13px] cursor-pointer font-semibold max-[680px]:w-full disabled:cursor-wait disabled:opacity-60"
      >
        {isPending ? 'Reloading…' : 'Reload'}
      </button>
      {error ? <span className="text-down text-xs">{error}</span> : null}
    </span>
  );
}
