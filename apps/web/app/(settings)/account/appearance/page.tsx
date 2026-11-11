"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme, type Theme } from "@/components/providers/theme-provider";
import { Panel, SettingsPageHeader } from "@/components/settings/panel";
import { cn } from "@/lib/utils";

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
];

export default function AppearancePage() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <SettingsPageHeader
        title="Appearance"
        description="How webhooks.cc looks in this browser. The choice is kept on this device."
      />

      <div className="space-y-6">
        <Panel
          id="theme"
          title="Theme"
          description="Light and Dark stay as picked; System follows your operating system and changes with it."
        >
          <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex overflow-hidden rounded-md border border-border"
          >
            {THEMES.map((option, index) => {
              const Icon = option.icon;
              const active = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTheme(option.value)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors cursor-pointer",
                    index > 0 && "border-l border-border",
                    active ? "bg-selected text-selected-foreground" : "hover:bg-muted"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </Panel>
      </div>
    </>
  );
}
