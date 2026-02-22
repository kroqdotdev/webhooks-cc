"use client";

import { useConvexAuth } from "convex/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConvexAuthProvider } from "@/components/providers/convex-auth-provider";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/installation", label: "Install" },
];

export function AuthNav() {
  return (
    <ConvexAuthProvider>
      <AuthNavContent />
    </ConvexAuthProvider>
  );
}

function AuthNavContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-6">
      {NAV_LINKS.filter((link) => pathname !== link.href).map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-muted-foreground hover:text-foreground font-medium transition-colors"
        >
          {link.label}
        </Link>
      ))}
      <ThemeToggle />
      {isLoading ? (
        <span className="neo-btn-outline text-sm py-2 px-4 w-28 text-center opacity-50">...</span>
      ) : isAuthenticated ? (
        <Link href="/dashboard" className="neo-btn-primary text-sm py-2 px-4 w-28 text-center">
          Dashboard
        </Link>
      ) : (
        <Link href="/login" className="neo-btn-outline text-sm py-2 px-4 w-28 text-center">
          Sign In
        </Link>
      )}
    </div>
  );
}
