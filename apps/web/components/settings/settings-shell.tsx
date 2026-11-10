"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { APP_VERSION } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSite } from "@/components/providers/site-provider";
import { useSettingsData } from "./settings-data";

const NEW_TEAM_HREF = "/teams?new=1";

interface NavItem {
  href: string;
  label: string;
  /** Muted text on the right: a team's role, or a count. */
  meta?: string;
  /** Draws attention to the item, such as a suspended team or waiting invites. */
  flag?: "warning" | "count";
  exact?: boolean;
}

const ACCOUNT_ITEMS: NavItem[] = [
  { href: "/account", label: "Profile", exact: true },
  { href: "/account/appearance", label: "Appearance" },
  { href: "/account/plan", label: "Plan and usage" },
  { href: "/account/api-keys", label: "API keys" },
  { href: "/account/agents", label: "Connected agents" },
  { href: "/account/shares", label: "Shares" },
  { href: "/account/share-links", label: "Share links" },
  { href: "/account/domains", label: "Domains" },
  { href: "/account/security", label: "Security" },
  { href: "/account/support-access", label: "Support access" },
];

/**
 * Keeps the section's own <title> in front of the layout's metadata one
 * ("Account"): React puts a newly mounted title first, and each navigation
 * mounts the metadata title again, so this one moves back in front whenever
 * the head changes (as the dashboard's does).
 */
function keepTitleFirst(own: HTMLTitleElement | null) {
  if (!own) return;
  const head = own.ownerDocument.head;
  const moveFirst = () => {
    const first = head.querySelector("title");
    if (first && first !== own && own.parentNode === head) head.insertBefore(own, first);
  };
  moveFirst();
  const observer = new MutationObserver(moveFirst);
  observer.observe(head, { childList: true });
  return () => observer.disconnect();
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "px-3 py-2",
        active
          ? "bg-selected text-selected-foreground font-medium"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <span className="truncate">{item.label}</span>
      {item.meta && (
        <span
          className={cn(
            "shrink-0 text-xs",
            item.flag === "warning" && !active && "text-amber-700 dark:text-amber-400",
            item.flag === "count" &&
              "min-w-5 rounded-sm bg-primary px-1.5 text-center font-semibold text-primary-foreground",
            !item.flag && (active ? "opacity-80" : "text-muted-foreground")
          )}
        >
          {item.meta}
        </span>
      )}
    </Link>
  );
}

function useTeamItems(): NavItem[] {
  const { teams, invites } = useSettingsData();
  return [
    {
      href: "/teams",
      label: "All teams",
      exact: true,
      meta: invites.length > 0 ? String(invites.length) : undefined,
      flag: invites.length > 0 ? "count" : undefined,
    },
    ...teams.map<NavItem>((team) => ({
      href: `/teams/${team.id}`,
      label: team.name,
      meta: team.suspended ? "Suspended" : team.role === "owner" ? "Owner" : "Member",
      flag: team.suspended ? "warning" : undefined,
    })),
  ];
}

/**
 * The account and team settings frame: a sticky side nav on wide screens, a
 * list to pick the same pages from on narrow ones, and the page beside it.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const teamItems = useTeamItems();
  const site = useSite();
  // The page shown, for the narrow screens' list and the title: the most specific match.
  const activeItem = [...ACCOUNT_ITEMS, ...teamItems]
    .filter((item) => isActive(pathname, item))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const activeHref = activeItem?.href ?? "";
  const onAccount = !!activeItem && ACCOUNT_ITEMS.includes(activeItem);
  // A team's name is its owner's own words and stays out of the title, which analytics read.
  const titleLabel = onAccount || activeItem?.href === "/teams" ? activeItem?.label : "Team";

  return (
    <div className="container mx-auto px-4 py-6 lg:py-10">
      {/* Each section names itself in the tab, so open account tabs can be told apart. */}
      {activeItem && (
        <title
          ref={keepTitleFirst}
        >{`${titleLabel} | ${onAccount ? "Account" : "Teams"} | ${site.name}`}</title>
      )}
      {/* Ten account pages and the teams do not fit a phone's width, so
          narrow screens pick the page from a list. */}
      <nav aria-label="Settings" className="lg:hidden mb-6">
        <Select value={activeHref} onValueChange={(href) => router.push(href)}>
          <SelectTrigger aria-label="Account section" className="w-full">
            <SelectValue placeholder="Account section" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel className="text-xs font-medium text-muted-foreground">
                Account
              </SelectLabel>
              {ACCOUNT_ITEMS.map((item) => (
                <SelectItem key={item.href} value={item.href}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            {/* Team names are the owner's own words; keep them out of autocapture. */}
            <SelectGroup className="ph-no-capture">
              <SelectLabel className="text-xs font-medium text-muted-foreground">Teams</SelectLabel>
              {teamItems.map((item) => (
                <SelectItem key={item.href} value={item.href}>
                  {item.meta && item.href !== "/teams"
                    ? `${item.label} (${item.meta})`
                    : item.label}
                </SelectItem>
              ))}
              <SelectItem value={NEW_TEAM_HREF}>New team</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </nav>

      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <nav aria-label="Settings" className="sticky top-20 space-y-6">
            <div className="space-y-1">
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">Account</p>
              <ul className="space-y-0.5">
                {ACCOUNT_ITEMS.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} pathname={pathname} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1">
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">Teams</p>
              <ul className="space-y-0.5">
                {teamItems.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} pathname={pathname} />
                  </li>
                ))}
                <li>
                  <Link
                    href={NEW_TEAM_HREF}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    New team
                  </Link>
                </li>
              </ul>
            </div>
            <div className="px-3 text-xs text-muted-foreground">
              <Link href="/support" className="block py-1 hover:text-foreground">
                Get support
              </Link>
              <Link href="/changelog" className="block py-1 hover:text-foreground">
                Version {APP_VERSION}
              </Link>
            </div>
          </nav>
        </aside>

        <main className="min-w-0 max-w-4xl">{children}</main>
      </div>
    </div>
  );
}
