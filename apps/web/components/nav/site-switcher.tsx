"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSite } from "@/components/providers/site-provider";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { SITES, listedOn, twoSites, type EndpointSite, type SiteKey } from "@/lib/site";
import { openEndpointSite, switchSite } from "@/lib/site-switch-client";

const ORDER: SiteKey[] = ["webhooks", "mailhooks"];

/** App pages both sites serve: switching from one lands on the same page there. */
const APP_PREFIXES = ["/dashboard", "/account", "/teams"];

/**
 * The page to land on across the switch, from the page shown now. The open
 * endpoint goes along only when `target` lists it: the dashboard opens any
 * endpoint named in the link, so one listed only here would stay open there.
 * `endpointSite` looks up the site of the endpoint in the query; null means
 * unknown, and the endpoint is kept.
 */
export function switchNextPath(
  pathname: string,
  search: string,
  target: SiteKey,
  endpointSite: (slug: string) => { site: EndpointSite | undefined } | null = () => null
): string {
  const inApp = APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  // Both sites have a pricing page; any other page is one site's own.
  if (pathname === "/pricing") return pathname;
  if (!inApp) return "/";
  const params = new URLSearchParams(search);
  const slug = params.get("endpoint");
  const known = slug ? endpointSite(slug) : null;
  if (!known || listedOn(known.site, target)) return `${pathname}${search}`;
  params.delete("endpoint");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** Switches to `target`, landing on the page shown now there when it is an app page. */
function switchFromHere(target: SiteKey, accessToken: string | undefined): void {
  void switchSite(
    target,
    switchNextPath(window.location.pathname, window.location.search, target, openEndpointSite),
    accessToken
  );
}

/**
 * Beside the wordmark: webhooks.cc or mailhooks.cc, the same account on
 * both. Signed in, switching carries the session over (lib/site-switch.ts)
 * and lands on the same app page there. Only with two sites.
 */
export function SiteSwitcher() {
  const site = useSite();
  const { session } = useAuth();
  if (!twoSites()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch site"
        title="Switch site"
        className="-ml-2 p-1 max-md:-ml-3 max-md:-my-2 max-md:p-2.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                if (!current) switchFromHere(key, session?.access_token);
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
  const { session } = useAuth();
  if (!twoSites()) return null;
  const other: SiteKey = site.key === "mailhooks" ? "webhooks" : "mailhooks";
  return (
    <button
      type="button"
      className="text-left text-foreground font-medium text-lg cursor-pointer"
      onClick={() => {
        onNavigate?.();
        switchFromHere(other, session?.access_token);
      }}
    >
      Switch to {SITES[other].name}
    </button>
  );
}
