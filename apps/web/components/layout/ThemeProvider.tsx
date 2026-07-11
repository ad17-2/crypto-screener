'use client';

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { writePrefs } from '@/lib/prefs';

export type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Initial render always assumes "dark" (server-safe default) and syncs on mount — no hydration
 * mismatch. Flash-of-wrong-theme is prevented separately by the beforeInteractive script in
 * app/layout.tsx, which stamps data-theme on <html> from localStorage before hydration.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'light') setTheme('light');
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      writePrefs({ theme: next });
      return next;
    });
  }, []);

  return <ThemeContext value={{ theme, toggleTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return value;
}
