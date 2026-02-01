import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind CSS classes with proper precedence handling.
 * Combines clsx (for conditional classes) with tailwind-merge (for deduplication).
 * Later classes override earlier ones: cn("p-4", "p-2") returns "p-2".
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
