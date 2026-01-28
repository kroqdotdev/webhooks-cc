"use client";

import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export function AuthNav() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  return (
    <div className="flex items-center gap-6">
      <Link
        href="/docs"
        className="text-muted-foreground hover:text-foreground font-medium transition-colors"
      >
        Docs
      </Link>
      <Link
        href="/installation"
        className="text-muted-foreground hover:text-foreground font-medium transition-colors"
      >
        Install
      </Link>
      <ThemeToggle />
      {isLoading ? (
        <span className="neo-btn-outline text-sm py-2 px-4 opacity-50">...</span>
      ) : isAuthenticated ? (
        <Link href="/dashboard" className="neo-btn-primary text-sm py-2 px-4">
          Dashboard
        </Link>
      ) : (
        <Link href="/login" className="neo-btn-outline text-sm py-2 px-4">
          Sign In
        </Link>
      )}
    </div>
  );
}
