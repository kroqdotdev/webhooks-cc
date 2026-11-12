"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Where toasts appear: a bar across the foot of the screen, 16px from its
 * edges, below the md width (globals.css stretches Sonner's own phone layout,
 * which stops at 600px, that far); from md up the bottom right corner, at most
 * 320px wide. Toasts are drawn by their callers (`toast.custom`), so they
 * carry the app's own surface look and font.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      mobileOffset={16}
      style={{ "--width": "320px", fontFamily: "inherit" } as React.CSSProperties}
    />
  );
}
