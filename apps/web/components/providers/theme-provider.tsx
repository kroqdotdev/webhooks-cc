"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { readStoredTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

export type { Theme };

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      if (isDark) {
        root.classList.add("dark");
        setResolvedTheme("dark");
      } else {
        root.classList.remove("dark");
        setResolvedTheme("light");
      }
    };

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    } else {
      applyTheme(theme === "dark");
    }
  }, [theme]);

  const handleSetTheme = (newTheme: Theme) => {
    setTheme(newTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch {
      // Storage is blocked: the choice lasts for this page view.
    }
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: handleSetTheme,
        resolvedTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

// Next renders `app/not-found.tsx` without the root layout, and so without
// ThemeProvider, when it answers some requests itself (a POST with a
// `Next-Action` header and a form body gets a 404 page that way). Outside a
// provider the hook hands back the defaults and the setters do nothing.
const FALLBACK_THEME: ThemeContextType = {
  theme: "system",
  setTheme: () => {},
  resolvedTheme: "dark",
};

export function useTheme() {
  return useContext(ThemeContext) ?? FALLBACK_THEME;
}
