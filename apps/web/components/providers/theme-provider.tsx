"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { trackUiStyleChanged } from "@/lib/analytics";
import { DEFAULT_UI_STYLE, readUiStyle, storeChosenUiStyle, type UiStyle } from "@/lib/ui-style";

export type Theme = "light" | "dark" | "system";

export type { UiStyle };

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
  uiStyle: UiStyle;
  setUiStyle: (style: UiStyle) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
  const [uiStyle, setUiStyleState] = useState<UiStyle>(DEFAULT_UI_STYLE);

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored) {
      setTheme(stored);
    }
    // The inline script in app/layout.tsx already applied the style before
    // paint, so only the settings page's control needs to catch up here.
    setUiStyleState(readUiStyle());
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
    localStorage.setItem("theme", newTheme);
  };

  const handleSetUiStyle = (style: UiStyle) => {
    const previous = readUiStyle();
    setUiStyleState(style);
    storeChosenUiStyle(style);
    document.documentElement.dataset.style = style;
    if (style !== previous) {
      trackUiStyleChanged({ from: previous, to: style });
    }
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: handleSetTheme,
        resolvedTheme,
        uiStyle,
        setUiStyle: handleSetUiStyle,
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
  uiStyle: DEFAULT_UI_STYLE,
  setUiStyle: () => {},
};

export function useTheme() {
  return useContext(ThemeContext) ?? FALLBACK_THEME;
}
