"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export function initialsFor(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0];
    return letters.toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

const SIZES = {
  sm: "h-6 w-6 text-[9px]",
  md: "h-8 w-8 text-[10px]",
  lg: "h-14 w-14 text-base",
} as const;

/** A person's picture, or their initials when there is none or it fails to load. */
export function Avatar({
  name,
  email,
  image,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  email: string;
  image?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = cn(
    "shrink-0 rounded-full border-strong border-line overflow-hidden",
    SIZES[size],
    className
  );

  if (image && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(base, "object-cover")}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(base, "bg-muted flex items-center justify-center font-bold leading-none")}
    >
      {initialsFor(name, email)}
    </span>
  );
}
