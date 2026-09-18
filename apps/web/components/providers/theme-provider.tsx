"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { trackUiStyleChanged } from "@/lib/analytics";
import { readUiStyleState, storeChosenUiStyle, type UiStyle } from "@/lib/ui-style";

type Theme = "light" | "dark" | "system";

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
  const [uiStyle, setUiStyleState] = useState<UiStyle>("classic");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored) {
      setTheme(stored);
    }
    // The inline script in app/layout.tsx already applied the stored style
    // before paint, so only the toggle state needs to catch up here.
    setUiStyleState(readUiStyleState().style);
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
    const previous = readUiStyleState();
    setUiStyleState(style);
    storeChosenUiStyle(style);
    document.documentElement.dataset.style = style;
    if (style !== previous.style) {
      trackUiStyleChanged({
        from: previous.style,
        to: style,
        sourceBefore: previous.source,
        assigned: previous.assigned,
      });
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

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
