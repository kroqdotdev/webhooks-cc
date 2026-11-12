"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Where toasts appear: the foot of the screen on a phone (16px from its
 * edges), the bottom right corner from Sonner's tablet width up, at most
 * 320px wide. Toasts are drawn by their callers (`toast.custom`), so they
 * carry the app's own surface look.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      mobileOffset={16}
      style={{ "--width": "320px" } as React.CSSProperties}
    />
  );
}
