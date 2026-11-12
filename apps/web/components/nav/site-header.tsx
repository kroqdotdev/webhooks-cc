"use client";

import { useAnnouncedRouter } from "@/lib/announced-router";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { leaveThrough } from "@/lib/leave-guard";
import { useSitePathname } from "@/lib/site-pathname";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { useSite } from "@/components/providers/site-provider";
import { UserDropdown } from "@/components/nav/user-dropdown";
import { SiteSwitchRow, SiteSwitcher } from "@/components/nav/site-switcher";
import { siteHeaderTop } from "@/lib/announcements";
import { resetUser, trackSignOut } from "@/lib/analytics";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/icons";
import { GITHUB_REPO_URL } from "@/lib/github";

interface NavLink {
  href: string;
  label: string;
  /** On the other site: marked with an arrow and named for screen readers. */
  external?: boolean;
  /** Left out of the desktop nav below lg, where the row runs out of room (the footer keeps it). */
  wideOnly?: boolean;
  /** Marked as the current page anywhere under this path, not only at `href`. */
  activeFor?: string;
}

const NAV_LINKS: NavLink[] = [
  { href: "/docs", label: "Docs" },
  { href: "/installation", label: "Install" },
  { href: "/pricing", label: "Pricing" },
  { href: "/blog", label: "Blog" },
];

// mailhooks.cc serves the docs too (app/mailhooks/docs), canonical on webhooks.cc.
const MAILHOOKS_LINKS: NavLink[] = [
  // One name for the catalogue everywhere: the dashboard section is Layouts too.
  { href: "/parse", label: "Layout gallery" },
  { href: "/integrations", label: "Integrations", wideOnly: true },
  { href: "/pricing", label: "Pricing" },
  { href: "/guides", label: "Guides" },
  // Mail-first visitors start the docs at email capture rather than the webhook quick start.
  { href: "/docs/email-capture", label: "Docs", activeFor: "/docs" },
];

interface SiteHeaderProps {
  /** Page context beside the wordmark: the endpoint switcher, a back link, section links. */
  children?: React.ReactNode;
  /** Section links the page shows in its children on wide screens, repeated in the phone menu. */
  mobileLinks?: NavLink[];
  /**
   * The dashboard is short on room: it drops the blog link, and on phones its
   * controls get a row of their own below the wordmark.
   */
  compact?: boolean;
  /**
   * Where the header sticks. By default it clears the fixed banners; inside a
   * scroll frame that already starts below them (the dashboard) pass "0px",
   * since a sticky offset counts from the frame, not the viewport.
   */
  top?: string;
  /**
   * The 404 page. It is prerendered once for every missing URL, so the header
   * must not read the URL there: the browser's path would differ from the
   * prerendered one and fail hydration.
   */
  notFound?: boolean;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Where the header is, for the sign-in and dashboard links. Whole path
 * segments only, so a page that merely starts with "/login" or "/dashboard"
 * is not taken for one.
 */
export function headerPlace(pathname: string): { onAuthPage: boolean; inApp: boolean } {
  return {
    // "/auth" itself is not a page (so a 404), only the routes under it.
    onAuthPage: isActive(pathname, "/login") || pathname.startsWith("/auth/"),
    inApp: ["/dashboard", "/account", "/teams"].some((prefix) => isActive(pathname, prefix)),
  };
}

/**
 * The one header, anchored at the top of every page: wordmark, the page's own
 * context, the site links, and either a sign-in link or the account menu. It
 * sits below the fixed maintenance and announcement banners when they show.
 */
export function SiteHeader({
  children,
  compact = false,
  top,
  notFound = false,
  mobileLinks = [],
}: SiteHeaderProps) {
  const pathname = useSitePathname();
  const router = useAnnouncedRouter();
  const isAuthenticated = useIsAuthenticated();
  const site = useSite();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Escape closes the phone menu and hands focus back to its button.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Close the phone menu on navigation, including browser back.
  useEffect(() => setOpen(false), [pathname]);

  const siteLinks = site.key === "mailhooks" ? MAILHOOKS_LINKS : NAV_LINKS;
  // The path the links are chosen by: none on the 404 page (see notFound).
  const navPath = notFound ? "" : pathname;
  const { onAuthPage, inApp } = headerPlace(navPath);
  // Every signed-in app page (dashboard, account, teams) gets the same short set,
  // so the header does not change as people move around the app.
  const appLinks = compact || (isAuthenticated && inApp);
  const links = appLinks
    ? siteLinks.filter((link) => !["/blog", "/integrations", "/pricing"].includes(link.href))
    : siteLinks;

  const handleSignOut = async () => {
    setOpen(false);
    trackSignOut();
    resetUser();
    await createClient().auth.signOut();
    router.push("/");
  };

  // The sign-in link is part of the prerendered HTML; signed-in visitors see
  // it swap for the dashboard link and their account menu after hydration.
  const authAction = isAuthenticated
    ? !inApp && (
        <Button
          variant="primary"
          className="py-1.5! px-3.5! text-sm"
          render={<Link href="/dashboard" />}
        >
          Dashboard
        </Button>
      )
    : !onAuthPage && (
        // Sign-up is the goal, so it is always one click away, not only in the hero.
        <span className="flex items-center gap-2">
          <Button
            variant="surface"
            className="py-1.5! px-3.5! text-sm"
            render={<Link href="/login" />}
          >
            Sign in
          </Button>
          <Button
            variant="primary"
            className="py-1.5! px-3.5! text-sm"
            render={<Link href="/login?mode=sign-up" />}
          >
            Sign up free
          </Button>
        </span>
      );

  return (
    <>
      <header
        className="sticky z-50 shrink-0 border-b bg-card"
        style={{ top: top ?? siteHeaderTop() }}
      >
        <div
          className={cn(
            // The app pages under a compact header run full width, so the header
            // does too, keeping the wordmark on the same left edge as the app.
            "px-4 flex items-center justify-between gap-4",
            compact
              ? "min-h-14 flex-wrap gap-y-2 py-2 md:h-14 md:flex-nowrap md:py-0"
              : "container mx-auto h-14"
          )}
        >
          {/* In compact mode on phones this group dissolves (display: contents), so
            the context can wrap onto its own full-width row under the wordmark. */}
          <div className={cn("flex items-center gap-3 min-w-0", compact && "max-md:contents")}>
            <div className="flex items-center gap-1 shrink-0">
              <Link href="/" className="font-bold text-lg tracking-tight">
                {site.name}
              </Link>
              <SiteSwitcher />
            </div>
            {compact && children ? (
              <div className="flex items-center gap-3 min-w-0 max-md:order-last max-md:w-full">
                {children}
              </div>
            ) : (
              children
            )}
          </div>

          {/* Desktop */}
          <nav
            aria-label="Site"
            className="hidden md:flex items-center gap-4 lg:gap-5 whitespace-nowrap shrink-0"
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(navPath, link.activeFor ?? link.href) ? "page" : undefined}
                className={cn(
                  // py-1 -my-1: a 24px hit area without moving the layout.
                  "text-sm font-medium py-1 -my-1 transition-colors hover:text-foreground",
                  link.wideOnly && "max-lg:hidden",
                  isActive(navPath, link.activeFor ?? link.href)
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {link.label}
                {link.external && (
                  <>
                    <ArrowUpRight aria-hidden className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
                    <span className="sr-only"> (on webhooks.cc)</span>
                  </>
                )}
              </Link>
            ))}
            {/* The repository, on the public pages only. */}
            {!appLinks && (
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium py-1 -my-1 text-muted-foreground transition-colors hover:text-foreground flex items-center gap-1.5 max-xl:hidden"
              >
                <GitHubIcon aria-hidden className="h-4 w-4" />
                GitHub
                <ArrowUpRight aria-hidden className="h-3.5 w-3.5 -ml-1" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            {authAction}
            {isAuthenticated && <UserDropdown />}
          </nav>

          {/* Phone */}
          <button
            ref={toggleRef}
            type="button"
            aria-controls={open ? "site-menu" : undefined}
            onClick={() => setOpen((prev) => !prev)}
            className="md:hidden p-2 rounded-md border hover:bg-muted transition-colors cursor-pointer"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {open && (
          // Behind the header's own background (its stacking context is above the
          // page), so it dims and blocks the page but never the menu button.
          <div
            aria-hidden
            className="md:hidden fixed inset-0 -z-10 bg-foreground/20"
            onClick={() => setOpen(false)}
          />
        )}
        {open && (
          <nav
            id="site-menu"
            aria-label="Site"
            // Tabbing out of the menu closes it, so focus never lands on the page hidden under it.
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && !event.currentTarget.contains(next) && next !== toggleRef.current) {
                setOpen(false);
              }
            }}
            className="md:hidden absolute top-full left-0 right-0 border-t shadow-float bg-card"
          >
            <div className="px-4 py-4 flex flex-col gap-3">
              <SiteSwitchRow onNavigate={() => setOpen(false)} />
              {[...mobileLinks, ...links].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={isActive(navPath, link.activeFor ?? link.href) ? "page" : undefined}
                  className="text-foreground font-medium text-lg"
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                  {link.external && (
                    <>
                      <ArrowUpRight aria-hidden className="inline h-3.5 w-3.5 ml-0.5 -mt-0.5" />
                      <span className="text-sm font-normal text-muted-foreground">
                        {" "}
                        on webhooks.cc
                      </span>
                    </>
                  )}
                </Link>
              ))}
              {!appLinks && (
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground font-medium text-lg flex items-center gap-2"
                  onClick={() => setOpen(false)}
                >
                  <GitHubIcon aria-hidden className="h-4.5 w-4.5" />
                  GitHub
                  <ArrowUpRight aria-hidden className="h-3.5 w-3.5 -ml-1" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
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
                  <Link
                    href="/support"
                    className="text-foreground font-medium text-lg"
                    onClick={() => setOpen(false)}
                  >
                    Support
                  </Link>
                  <div className="pt-3 border-t border-foreground/20">
                    <button
                      type="button"
                      onClick={() => leaveThrough(() => void handleSignOut())}
                      className="text-foreground font-medium text-lg cursor-pointer"
                    >
                      Sign out
                    </button>
                  </div>
                </>
              ) : (
                !onAuthPage && (
                  <div className="pt-3 border-t border-foreground/20">
                    <Button
                      variant="surface"
                      className="inline-block text-sm"
                      render={<Link href="/login" onClick={() => setOpen(false)} />}
                    >
                      Sign in
                    </Button>
                    <Button
                      variant="primary"
                      className="inline-block text-sm ml-2"
                      render={<Link href="/login?mode=sign-up" onClick={() => setOpen(false)} />}
                    >
                      Sign up free
                    </Button>
                  </div>
                )
              )}
            </div>
          </nav>
        )}
      </header>
      {/* The "Skip to content" link (app/layout.tsx) lands here, past the header. */}
      <div id="main-content" tabIndex={-1} className="outline-none" />
    </>
  );
}
