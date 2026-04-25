"use client";

import { cn } from "@/lib/utils";
import { getWebProviderLabel } from "@/lib/provider-catalog";

export function ProviderBadge({
  provider,
  className,
}: {
  provider?: string | null;
  className?: string;
}) {
  const label = getWebProviderLabel(provider);
  if (!label) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center border border-foreground/25 bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground",
        className
      )}
      title={label}
    >
      {label}
    </span>
  );
}
