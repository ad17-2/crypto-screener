import type { Metadata } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/layout/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crypto Dashboard',
};

/**
 * beforeInteractive: Next.js injects this into <head> and runs it before hydration, so
 * data-theme is correct on <html> by first paint — no flash of the wrong theme.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var prefs = JSON.parse(localStorage.getItem("tape.prefs") || "{}");
    if (prefs.theme === "light") document.documentElement.setAttribute("data-theme", "light");
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
