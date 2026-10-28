"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme, type Theme, type UiStyle } from "@/components/providers/theme-provider";
import { Panel, SettingsPageHeader } from "@/components/settings/panel";
import { cn } from "@/lib/utils";

const STYLES: { value: UiStyle; label: string; description: string }[] = [
  {
    value: "clean",
    label: "Clean",
    description: "Paper and ink: a quiet canvas, hairlines, one green. The default.",
  },
  {
    value: "classic",
    label: "Classic",
    description: "The original look: hard shadows, heavy lines and bright colour.",
  },
];

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * A swatch of the style itself: the canvas, lines, shadow and accent it would
 * draw with, in the mode the page is in. The colours are the style's own
 * tokens written out, since the page only carries the current style's.
 */
function StyleSwatch({ style }: { style: UiStyle }) {
  const classic = style === "classic";
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-16 w-24 shrink-0 rounded-md border p-2",
        classic
          ? "border-[2px] border-[#000] bg-[#fafaf7] dark:border-[#fafaf9] dark:bg-[#18181b]"
          : "border-[#dfe3e9] bg-[#f7f8fa] dark:border-[#282c33] dark:bg-[#0f1115]"
      )}
    >
      <div
        className={cn(
          "h-full w-full rounded-sm border",
          classic
            ? "border-[2px] border-[#000] bg-white shadow-[3px_3px_0_0_#000] dark:border-[#fafaf9] dark:bg-[#222226] dark:shadow-[3px_3px_0_0_#fafaf9]"
            : "border-[#dfe3e9] bg-white dark:border-[#282c33] dark:bg-[#15181d]"
        )}
      >
        <div
          className={cn(
            "m-1.5 h-2 w-8 rounded-sm",
            classic ? "bg-[#00d08a] dark:bg-[#00e6a3]" : "bg-[#0e6b4e] dark:bg-[#3bd39c]"
          )}
        />
      </div>
    </div>
  );
}

export default function AppearancePage() {
  const { theme, setTheme, uiStyle, setUiStyle } = useTheme();

  return (
    <>
      <SettingsPageHeader
        title="Appearance"
        description="How webhooks.cc looks in this browser. The choice is kept on this device."
      />

      <div className="space-y-6">
        <Panel id="style" title="Style" description="Two looks share every screen; pick one.">
          <div role="radiogroup" aria-label="Style" className="grid gap-3 sm:grid-cols-2">
            {STYLES.map((option) => {
              const active = uiStyle === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setUiStyle(option.value)}
                  className={cn(
                    "flex items-center gap-4 rounded-lg border-strong p-4 text-left transition-colors cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-selected text-selected-foreground"
                      : "border-line hover:bg-muted"
                  )}
                >
                  <StyleSwatch style={option.value} />
                  <span className="min-w-0">
                    <span className="block font-bold">{option.label}</span>
                    <span
                      className={cn(
                        "block text-sm",
                        active ? "opacity-80" : "text-muted-foreground"
                      )}
                    >
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel
          id="theme"
          title="Theme"
          description="System follows your operating system and changes with it."
        >
          <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex overflow-hidden rounded-md border-strong border-line"
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
                    index > 0 && "border-l-strong border-line",
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
