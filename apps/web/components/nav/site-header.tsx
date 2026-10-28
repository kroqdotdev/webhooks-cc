"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { UserDropdown } from "@/components/nav/user-dropdown";
import { siteHeaderTop } from "@/lib/announcements";
import { resetUser } from "@/lib/analytics";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/installation", label: "Install" },
  { href: "/blog", label: "Blog" },
];

interface SiteHeaderProps {
  /** Page context beside the wordmark: the endpoint switcher, a back link, section links. */
  children?: React.ReactNode;
  /** The dashboard is short on room, so it drops the blog link. */
  compact?: boolean;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one header, anchored at the top of every page: wordmark, the page's own
 * context, the site links, and either a sign-in link or the account menu. It
 * sits below the fixed maintenance and announcement banners when they show.
 */
export function SiteHeader({ children, compact = false }: SiteHeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthenticated = useIsAuthenticated();
  const [open, setOpen] = useState(false);

  // Close the phone menu on navigation, including browser back.
  useEffect(() => setOpen(false), [pathname]);

  const links = compact ? NAV_LINKS.filter((link) => link.href !== "/blog") : NAV_LINKS;
  const onAuthPage = pathname.startsWith("/login") || pathname.startsWith("/auth/");
  const inApp = ["/dashboard", "/account", "/teams"].some((prefix) => pathname.startsWith(prefix));

  const handleSignOut = async () => {
    setOpen(false);
    resetUser();
    await createClient().auth.signOut();
    router.push("/");
  };

  // The sign-in link is part of the prerendered HTML; signed-in visitors see
  // it swap for the dashboard link and their account menu after hydration.
  const authAction = isAuthenticated
    ? !inApp && (
        <Link href="/dashboard" className="ui-btn-primary py-1.5! px-3.5! text-sm">
          Dashboard
        </Link>
      )
    : !onAuthPage && (
        <Link href="/login" className="ui-btn-outline py-1.5! px-3.5! text-sm">
          Sign in
        </Link>
      );

  return (
    <header
      className="sticky z-50 shrink-0 border-b-strong border-line bg-background clean:bg-card"
      style={{ top: siteHeaderTop() }}
    >
      <div className="container mx-auto px-4 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="font-bold text-lg tracking-tight shrink-0">
            webhooks.cc
          </Link>
          {children}
        </div>

        {/* Desktop */}
        <nav aria-label="Site" className="hidden md:flex items-center gap-5">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(pathname, link.href) ? "page" : undefined}
              className={cn(
                "text-sm font-medium transition-colors hover:text-foreground",
                isActive(pathname, link.href) ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {link.label}
            </Link>
          ))}
          {authAction}
          {isAuthenticated && <UserDropdown />}
        </nav>

        {/* Phone */}
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="md:hidden p-2 rounded-md border-strong border-line hover:bg-muted transition-colors cursor-pointer"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <nav
          aria-label="Site"
          className="md:hidden absolute top-full left-0 right-0 border-t-strong border-line bg-background clean:bg-card shadow-raised"
        >
          <div className="px-4 py-4 flex flex-col gap-3">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-foreground font-medium text-lg"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {isAuthenticated ? (
              <>
                <Link
                  href="/dashboard"
                  className="text-foreground font-medium text-lg"
                  onClick={() => setOpen(false)}
                >
                  Dashboard
                </Link>
                <Link
                  href="/account"
                  className="text-foreground font-medium text-lg"
                  onClick={() => setOpen(false)}
                >
                  Account
                </Link>
                <Link
                  href="/teams"
                  className="text-foreground font-medium text-lg"
                  onClick={() => setOpen(false)}
                >
                  Teams
                </Link>
                <div className="pt-3 border-t-strong border-foreground/20">
                  <button
                    type="button"
                    onClick={() => void handleSignOut()}
                    className="text-foreground font-medium text-lg cursor-pointer"
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              !onAuthPage && (
                <div className="pt-3 border-t-strong border-foreground/20">
                  <Link
                    href="/login"
                    className="ui-btn-outline inline-block text-sm"
                    onClick={() => setOpen(false)}
                  >
                    Sign in
                  </Link>
                </div>
              )
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
