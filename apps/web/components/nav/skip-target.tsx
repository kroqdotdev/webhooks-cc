"use client";

import { createContext, useContext } from "react";

/**
 * Where the "Skip to content" link (app/layout.tsx) lands: right after the
 * site header, or at the top of a page shown before its header can render
 * (a sign-in check still loading, the two-factor step). Render it once per
 * page.
 */
export const SKIP_TARGET_ID = "main-content";

const PlacedAbove = createContext(false);

/**
 * Wraps what a page renders under its own site header (which already holds
 * the target), so a loading screen or the two-factor step inside does not
 * add a second element with the same id.
 */
export function SkipTargetAbove({ children }: { children: React.ReactNode }) {
  return <PlacedAbove.Provider value>{children}</PlacedAbove.Provider>;
}

export function SkipTarget() {
  const placed = useContext(PlacedAbove);
  if (placed) return null;
  return <div id={SKIP_TARGET_ID} tabIndex={-1} className="outline-none" />;
}
