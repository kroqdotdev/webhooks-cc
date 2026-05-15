"use client";

import { cn } from "@/lib/utils";
import { getWebProviderInfo } from "@/lib/provider-catalog";
import { ProviderIcon } from "./provider-icon";

export function ProviderBadge({
  provider,
  className,
}: {
  provider?: string | null;
  className?: string;
}) {
  const providerInfo = getWebProviderInfo(provider);
  if (!providerInfo) {
    return null;
  }

  const { icon, label } = providerInfo;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border border-foreground/25 bg-muted px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground",
        className
      )}
      aria-label={`Detected provider: ${label}`}
      title={label}
    >
      <span
        aria-hidden="true"
        className="inline-grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-[2px] border"
        style={{
          backgroundColor: icon.background,
          borderColor: icon.border,
          color: icon.foreground,
        }}
      >
        <ProviderIcon glyph={icon.glyph} fallbackText={icon.text} />
      </span>
      {label}
    </span>
  );
}
