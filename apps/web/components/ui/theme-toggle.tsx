"use client";

import { useTheme, type UiStyle } from "@/components/providers/theme-provider";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Monitor, Moon, Square, Squircle, Sun } from "lucide-react";

type ThemeOption = "light" | "system" | "dark";

const STYLE_OPTIONS: { value: UiStyle; label: string; icon: LucideIcon }[] = [
  { value: "classic", label: "Classic style", icon: Square },
  { value: "clean", label: "Clean style", icon: Squircle },
];

const THEME_OPTIONS: { value: ThemeOption; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light mode", icon: Sun },
  { value: "system", label: "System theme", icon: Monitor },
  { value: "dark", label: "Dark mode", icon: Moon },
];

/** Visual style switch followed by the light, system, and dark switch. */
export function ThemeToggle() {
  const { theme, setTheme, uiStyle, setUiStyle } = useTheme();
  const otherStyle: UiStyle = uiStyle === "classic" ? "clean" : "classic";
  const OtherIcon = otherStyle === "clean" ? Squircle : Square;
  const switchLabel = `Switch to ${otherStyle} style`;

  return (
    <div className="flex items-center gap-2">
      {/* Phones have room for one style button, not a two-segment control */}
      <button
        onClick={() => setUiStyle(otherStyle)}
        className="p-2 sm:hidden rounded-md border-strong border-line bg-background hover:bg-muted transition-colors cursor-pointer"
        aria-label={switchLabel}
        title={switchLabel}
      >
        <OtherIcon className="h-4 w-4" />
      </button>
      <div className="hidden sm:flex">
        <SegmentedToggle options={STYLE_OPTIONS} value={uiStyle} onChange={setUiStyle} />
      </div>
      <SegmentedToggle options={THEME_OPTIONS} value={theme} onChange={setTheme} />
    </div>
  );
}

function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon: LucideIcon }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border-strong border-line bg-background">
      {options.map((option, index) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "p-2 sm:p-2.5 transition-colors cursor-pointer",
              index > 0 && "border-l-strong border-line",
              active ? "bg-selected text-selected-foreground" : "hover:bg-muted"
            )}
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
