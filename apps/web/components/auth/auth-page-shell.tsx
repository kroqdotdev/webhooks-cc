"use client";

import type { ReactNode } from "react";
import { SiteHeader } from "@/components/nav/site-header";

/**
 * Minimal nav + centered column shared by the auth pages (/login and
 * /auth/reset-password): no dashboard chrome, just a way back home.
 */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />

      <main className="flex-1 flex items-center justify-center px-4 pt-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
