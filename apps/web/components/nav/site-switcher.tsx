"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSite } from "@/components/providers/site-provider";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { SITES, siteSwitchUrl, twoSites, type SiteKey } from "@/lib/site";

const ORDER: SiteKey[] = ["webhooks", "mailhooks"];

/** App pages both sites serve: switching from one lands on the same page there. */
const APP_PREFIXES = ["/dashboard", "/account", "/teams"];

/** The page to land on across the switch, from the page shown now. */
export function switchNextPath(pathname: string, search: string): string {
  const inApp = APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  return inApp ? `${pathname}${search}` : "/";
}

/** Where switching to `target` goes from the page shown now. */
function switchHref(target: SiteKey, signedIn: boolean): string {
  return siteSwitchUrl(
    target,
    switchNextPath(window.location.pathname, window.location.search),
    signedIn
  );
}

/**
 * Beside the wordmark: webhooks.cc or mailhooks.cc, the same account on
 * both. Signed in, switching carries the session over (lib/site-switch.ts)
 * and lands on the same app page there. Only with two sites.
 */
export function SiteSwitcher() {
  const site = useSite();
  const signedIn = useIsAuthenticated();
  if (!twoSites()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch site"
        title="Switch site"
        className="-ml-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronsUpDown className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {ORDER.map((key) => {
          const info = SITES[key];
          const current = key === site.key;
          return (
            <DropdownMenuItem
              key={key}
              className="cursor-pointer items-start gap-2 py-2"
              aria-current={current ? "page" : undefined}
              onSelect={() => {
                if (!current) window.location.assign(switchHref(key, signedIn));
              }}
            >
              <span className="flex-1 min-w-0">
                <span className="block font-semibold">{info.name}</span>
                <span className="block text-xs text-muted-foreground">{info.tagline}</span>
              </span>
              {current && <Check className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The phone menu's row: a link to the other site, signed in when this one is. */
export function SiteSwitchRow({ onNavigate }: { onNavigate?: () => void }) {
  const site = useSite();
  const signedIn = useIsAuthenticated();
  if (!twoSites()) return null;
  const other: SiteKey = site.key === "mailhooks" ? "webhooks" : "mailhooks";
  return (
    <button
      type="button"
      className="text-left text-foreground font-medium text-lg cursor-pointer"
      onClick={() => {
        onNavigate?.();
        window.location.assign(switchHref(other, signedIn));
      }}
    >
      Switch to {SITES[other].name}
    </button>
  );
}
