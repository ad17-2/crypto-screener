import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/layout/ThemeProvider';
import './globals.css';

/*
 * Self-hosted at build time (next/font downloads + serves this from our own domain, no
 * runtime request to Google) — required by the deploy env's strict network policy. One face for
 * the whole app (see globals.css: --font-sans and --font-mono both point at this variable).
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

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
    // Theme script sets data-theme before hydration; suppress the expected <html> mismatch.
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
