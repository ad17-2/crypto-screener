'use client';

import { useEffect, useId, useState } from 'react';

type Placement = 'top' | 'bottom';

type InfoTipProps = {
  term: string;
  definition: string;
  /**
   * 'bottom' is required inside `overflow: hidden` containers whose trigger sits at the top edge
   * — the coin table clips its own sticky header row, so a tooltip opening upward there is
   * invisible. Default 'top' everywhere else.
   */
  placement?: Placement;
};

/**
 * ⓘ trigger that reveals a definition on hover or focus. Backs the "hide jargon behind an
 * info icon" pattern used across the dashboard. Follows the WAI-ARIA APG tooltip pattern:
 * the popover stays mounted (so aria-describedby always resolves to a real element) and
 * visibility is toggled with CSS rather than the native `title` attribute.
 */
export function InfoTip({ term, definition, placement = 'top' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <span className="tooltip-trigger">
      <button
        type="button"
        className="help-tip"
        aria-describedby={tooltipId}
        aria-label={`What is ${term}?`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ⓘ
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`tooltip-popover${placement === 'bottom' ? ' below' : ''}${open ? ' open' : ''}`}
      >
        <strong>{term}</strong>
        {': '}
        {definition}
      </span>
    </span>
  );
}

type TermProps = {
  label: string;
  definition: string;
  placement?: Placement;
};

/** A label paired with its InfoTip — the label + ⓘ combo recurs constantly across the dashboard. */
export function Term({ label, definition, placement = 'top' }: TermProps) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <InfoTip term={label} definition={definition} placement={placement} />
    </span>
  );
}
