"use client";

import { useSyncExternalStore } from "react";
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";

export type Theme = "light" | "dark" | "system";

/** Kept in localStorage under this key, so a browser's earlier choice still applies. */
const STORAGE_KEY = "theme";

/**
 * Light or dark, chosen in the browser (Account > Appearance) and kept in
 * localStorage, not on the account. next-themes sets the `dark` class on
 * <html> from an inline script before first paint, so a page never flashes
 * the wrong mode, and follows the system while the choice is System.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      storageKey={STORAGE_KEY}
      defaultTheme="system"
      enableSystem
      // The page's own CSS decides scrollbars and controls; no color-scheme on <html>.
      enableColorScheme={false}
    >
      {children}
    </NextThemesProvider>
  );
}

const noSubscribe = () => () => {};

/**
 * The choice and the mode it resolves to. Until hydration is done the server's
 * answer holds (System, dark), so the first client render matches the HTML.
 * Outside the provider (Next renders some 404s without the root layout) the
 * setter does nothing.
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
} {
  const { theme, setTheme, resolvedTheme } = useNextTheme();
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
  const chosen: Theme = theme === "light" || theme === "dark" ? theme : "system";
  return {
    theme: hydrated ? chosen : "system",
    setTheme,
    resolvedTheme: hydrated && resolvedTheme === "light" ? "light" : "dark",
  };
}
