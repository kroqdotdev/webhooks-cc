import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge does not know the style-aware utilities from app/globals.css.
 * Without this, it reads border-strong as a border color and drops it next to
 * border-line, cannot tell that shadow-raised replaces shadow-lg, and keeps a
 * primitive's tracking-tight next to caps.
 */
const twMerge = extendTailwindMerge<"caps">({
  extend: {
    theme: {
      shadow: ["raised-sm", "raised", "raised-lg"],
    },
    conflictingClassGroups: {
      caps: ["tracking", "text-transform"],
    },
    classGroups: {
      caps: ["caps", "caps-wide"],
      "border-w": [{ border: ["strong"] }],
      "border-w-x": [{ "border-x": ["strong"] }],
      "border-w-y": [{ "border-y": ["strong"] }],
      "border-w-t": [{ "border-t": ["strong"] }],
      "border-w-r": [{ "border-r": ["strong"] }],
      "border-w-b": [{ "border-b": ["strong"] }],
      "border-w-l": [{ "border-l": ["strong"] }],
      "divide-x": [{ "divide-x": ["strong"] }],
      "divide-y": [{ "divide-y": ["strong"] }],
    },
  },
});

/**
 * Merges Tailwind CSS classes with proper precedence handling.
 * Combines clsx (for conditional classes) with tailwind-merge (for deduplication).
 * Later classes override earlier ones: cn("p-4", "p-2") returns "p-2".
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
