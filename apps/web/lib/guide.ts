/**
 * Pure dismiss/reopen logic for the "How to read this screener" guide, split out of
 * GuideDrawer.tsx so it's testable without mounting a component. Persisted via the same
 * lib/prefs.ts merge pattern WatchlistWorkbench uses for sort prefs.
 */

const GUIDE_DISMISSED_PREF_KEY = 'guideDismissed';

/** False (never dismissed) for a first visit or an unrecognized/corrupt prefs blob. */
export function guideDismissed(prefs: Record<string, unknown>): boolean {
  return prefs[GUIDE_DISMISSED_PREF_KEY] === true;
}

/** The patch to hand to writePrefs() when the guide is closed. */
export function dismissGuidePatch(): Record<string, unknown> {
  return { [GUIDE_DISMISSED_PREF_KEY]: true };
}
