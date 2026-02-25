"use client";

import { useTheme } from "@/components/providers/theme-provider";
import { Monitor, Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  return <ThemeToggleButtons />;
}

function ThemeToggleButtons() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center border-2 border-foreground rounded-none bg-background">
      <button
        onClick={() => setTheme("light")}
        className={`p-2 transition-colors cursor-pointer ${
          theme === "light" ? "bg-foreground text-background" : "hover:bg-muted"
        }`}
        aria-label="Light mode"
      >
        <Sun className="h-4 w-4" />
      </button>
      <button
        onClick={() => setTheme("system")}
        className={`p-2 transition-colors cursor-pointer border-x-2 border-foreground ${
          theme === "system" ? "bg-foreground text-background" : "hover:bg-muted"
        }`}
        aria-label="System theme"
      >
        <Monitor className="h-4 w-4" />
      </button>
      <button
        onClick={() => setTheme("dark")}
        className={`p-2 transition-colors cursor-pointer ${
          theme === "dark" ? "bg-foreground text-background" : "hover:bg-muted"
        }`}
        aria-label="Dark mode"
      >
        <Moon className="h-4 w-4" />
      </button>
    </div>
  );
}
