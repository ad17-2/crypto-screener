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
  const [queued, setQueued] = useState(false);

  const handleClick = () => {
    setError(null);
    setQueued(false);
    startTransition(async () => {
      const result = await triggerRefresh();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setQueued(true);
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="link cursor-pointer bg-transparent border-0 p-0 disabled:cursor-wait disabled:opacity-60"
      >
        {isPending ? 'Reloading…' : 'Reload'}
      </button>
      {error ? (
        <span className="text-down text-xs">{error}</span>
      ) : queued ? (
        <span className="text-ash text-xs">Queued — new data in ~25 min</span>
      ) : null}
    </span>
  );
}
