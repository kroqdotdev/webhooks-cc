"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { getMaintenanceTopOffset } from "@/lib/announcements";

/**
 * Minimal nav + centered column shared by the auth pages (/login and
 * /auth/reset-password): no dashboard chrome, just a way back home.
 */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav
        className="fixed left-4 right-4 z-50"
        style={{ top: `calc(${getMaintenanceTopOffset()} + var(--ann-h, 0px))` }}
      >
        <div className="max-w-6xl mx-auto border-2 border-foreground bg-background shadow-neo">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <div className="flex items-center gap-6">
              <Link
                href="/docs"
                className="hidden sm:inline text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Docs
              </Link>
              <Link
                href="/installation"
                className="hidden sm:inline text-muted-foreground hover:text-foreground font-medium transition-colors"
              >
                Install
              </Link>
              <ThemeToggle />
              <Link href="/" className="neo-btn-outline text-sm py-2 px-4 text-center">
                Home
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-24">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
