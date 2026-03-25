"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/installation", label: "Install" },
];

export function AuthNav() {
  return (
    <SupabaseAuthProvider>
      <AuthNavContent />
    </SupabaseAuthProvider>
  );
}

function AuthNavContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close mobile menu on route change (e.g. browser back)
  useEffect(() => setOpen(false), [pathname]);

  const filteredLinks = NAV_LINKS.filter((link) => pathname !== link.href);

  const authButton = isLoading ? (
    <span className="neo-btn-outline text-sm py-2 px-4 w-28 text-center opacity-50">...</span>
  ) : isAuthenticated ? (
    <Link
      href="/dashboard"
      className="neo-btn-primary text-sm py-2 px-4 w-28 text-center"
      onClick={() => setOpen(false)}
    >
      Dashboard
    </Link>
  ) : (
    <Link
      href="/login"
      className="neo-btn-outline text-sm py-2 px-4 w-28 text-center"
      onClick={() => setOpen(false)}
    >
      Sign In
    </Link>
  );

  return (
    <>
      {/* Desktop */}
      <div className="hidden md:flex items-center gap-6">
        {filteredLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="text-muted-foreground hover:text-foreground font-medium transition-colors"
          >
            {link.label}
          </Link>
        ))}
        <ThemeToggle />
        {authButton}
      </div>

      {/* Mobile toggle */}
      <div className="flex md:hidden items-center gap-3">
        <ThemeToggle />
        <button
          onClick={() => setOpen((prev) => !prev)}
          className="p-2 border-2 border-foreground hover:bg-muted transition-colors cursor-pointer"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="absolute md:hidden top-full left-0 right-0 border-t-2 border-foreground bg-background shadow-neo">
          <div className="px-6 py-4 flex flex-col gap-4">
            {filteredLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-foreground font-medium text-lg"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="pt-2 border-t-2 border-foreground/20">{authButton}</div>
          </div>
        </div>
      )}
    </>
  );
}
