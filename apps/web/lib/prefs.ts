const PREFS_KEY = 'tape.prefs';

/**
 * Shared between ThemeProvider and WatchlistWorkbench. writePrefs merges rather than overwrites
 * so neither owner clobbers keys it doesn't own.
 */
export function readPrefs(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writePrefs(patch: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    // storage unavailable (private browsing, quota) — the change still applies for this session
  }
}
