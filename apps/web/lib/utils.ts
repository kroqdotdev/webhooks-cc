import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The tinted shadows from app/globals.css, so a call site's shadow-float
// replaces a primitive's shadow-lg instead of sitting next to it.
const twMerge = extendTailwindMerge({
  extend: { theme: { shadow: ["surface", "float", "float-lg"] } },
});

/**
 * Merges Tailwind CSS classes with proper precedence handling.
 * Combines clsx (for conditional classes) with tailwind-merge (for deduplication).
 * Later classes override earlier ones: cn("p-4", "p-2") returns "p-2".
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
