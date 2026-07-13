'use client';

import { useEffect, useId, useState } from 'react';

type Placement = 'top' | 'bottom';
type Align = 'left' | 'right';

type InfoTipProps = {
  term: string;
  definition: string;
  /** Which side of the trigger the popover opens toward vertically. Default 'top'. */
  placement?: Placement;
  /**
   * Which edge of the popover is pinned to the trigger. 'left' (default) grows rightward; 'right'
   * grows leftward and is required for triggers near the right edge of the page, where a
   * left-anchored 260px box would otherwise hang off the viewport and give the whole document a
   * phantom sideways scroll.
   */
  align?: Align;
};

/**
 * ⓘ trigger that reveals a definition on hover or focus. Backs the "hide jargon behind an
 * info icon" pattern used across the dashboard. Follows the WAI-ARIA APG tooltip pattern:
 * the popover stays mounted (so aria-describedby always resolves to a real element) and
 * visibility is toggled with CSS rather than the native `title` attribute.
 */
export function InfoTip({ term, definition, placement = 'top', align = 'left' }: InfoTipProps) {
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
      {/* `whitespace-normal` is a utility rather than part of `.tooltip-popover` on purpose -- see the
          note there. Column headers set `nowrap`, and the popover inherits it without this. */}
      <span
        id={tooltipId}
        role="tooltip"
        className={`tooltip-popover whitespace-normal${placement === 'bottom' ? ' below' : ''}${align === 'right' ? ' align-right' : ''}${open ? ' open' : ''}`}
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
  align?: Align;
};

/** A label paired with its InfoTip — the label + ⓘ combo recurs constantly across the dashboard. */
export function Term({ label, definition, placement = 'top', align = 'left' }: TermProps) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <InfoTip term={label} definition={definition} placement={placement} align={align} />
    </span>
  );
}
