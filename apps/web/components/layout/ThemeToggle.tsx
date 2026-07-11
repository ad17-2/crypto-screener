'use client';

import { useTheme } from './ThemeProvider';

/** Label shows the theme you'd switch *to*, not the current theme. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      className="theme-btn h-9 border border-line bg-panel text-ink rounded-md px-2.5 text-[13px] cursor-pointer font-semibold min-w-10"
    >
      {theme === 'light' ? 'Dark' : 'Light'}
    </button>
  );
}
