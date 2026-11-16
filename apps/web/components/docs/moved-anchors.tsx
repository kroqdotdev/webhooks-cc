"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Sends an old `#section` link to the page the section moved to. Renders
 * nothing; see `lib/docs-moved-anchors.ts`.
 */
export function MovedAnchors({ anchors }: { anchors: Record<string, string> }) {
  const router = useRouter();

  useEffect(() => {
    // Every moved id is ASCII; a malformed escape (`#%`) is simply not one.
    let id: string;
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    const target = Object.hasOwn(anchors, id) ? anchors[id] : undefined;
    if (target) router.replace(`${target}#${id}`);
  }, [anchors, router]);

  return null;
}
