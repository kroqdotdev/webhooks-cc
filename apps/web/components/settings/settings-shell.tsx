"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { APP_VERSION } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import { useSettingsData } from "./settings-data";

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
  { href: "/account/share-links", label: "Share links" },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavLink({
  item,
  pathname,
  compact,
}: {
  item: NavItem;
  pathname: string;
  compact?: boolean;
}) {
  const active = isActive(pathname, item);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact ? "px-3 py-1.5 whitespace-nowrap" : "px-3 py-2",
        active
          ? "bg-selected text-selected-foreground font-medium"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      <span className="truncate">{item.label}</span>
      {item.meta && !compact && (
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
 * scrolling strip of the same links on narrow ones, and the page beside it.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const teamItems = useTeamItems();

  return (
    <div className="container mx-auto px-4 py-6 lg:py-10">
      <nav
        aria-label="Settings"
        className="lg:hidden -mx-4 mb-6 overflow-x-auto border-b-strong border-line px-4 pb-3"
      >
        <ul className="flex gap-1">
          {[...ACCOUNT_ITEMS, ...teamItems].map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} compact />
            </li>
          ))}
        </ul>
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
                    href="/teams?new=1"
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    New team
                  </Link>
                </li>
              </ul>
            </div>
            <Link
              href="/changelog"
              className="block px-3 text-xs text-muted-foreground hover:text-foreground"
            >
              Version {APP_VERSION}
            </Link>
          </nav>
        </aside>

        <main className="min-w-0 max-w-3xl">{children}</main>
      </div>
    </div>
  );
}
