"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStaff, type StaffStatus } from "./use-staff";

const OpsContext = createContext<{ token: string | null; staff: StaffStatus | null }>({
  token: null,
  staff: null,
});

export function useOps() {
  return useContext(OpsContext);
}

const NAV = [
  { href: "/ops", label: "Overview", exact: true },
  { href: "/ops/tickets", label: "Tickets", count: "waiting" as const },
  { href: "/ops/accounts", label: "Accounts" },
  { href: "/ops/refunds", label: "Refunds" },
  { href: "/ops/sharing", label: "Sharing", count: "reports" as const },
  { href: "/ops/saved-replies", label: "Saved replies" },
];

/** The same answer a missing page gives: /ops does not announce itself. */
function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-bold clean:font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you are looking for does not exist.</p>
      <Button asChild variant="outline">
        <Link href="/dashboard">Go to the dashboard</Link>
      </Button>
    </main>
  );
}

function NeedsTwoFactor() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-4 px-6">
      <ShieldAlert className="h-6 w-6 text-staff" aria-hidden="true" />
      <h1 className="text-2xl font-bold clean:font-semibold">Two-factor sign-in first</h1>
      <p className="text-sm text-muted-foreground">
        Operations shows other people&rsquo;s accounts, so it needs a session that signed in with an
        authenticator app. Set it up under Security, then come back.
      </p>
      <Button asChild className="self-start">
        <Link href="/account/security">Set up two-factor sign-in</Link>
      </Button>
    </main>
  );
}

/**
 * The operations frame: a narrow nav rail and the page. Rendered only for
 * staff with two-factor sign-in; everyone else sees a plain not-found page,
 * and every ops route answers 404 to them as well, so the page shell gives
 * nothing away.
 */
export function OpsShell({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const token = session?.access_token ?? null;
  const staff = useStaff(session?.user.id ?? null, token);
  const pathname = usePathname();

  if (!staff) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }
  if (!staff.staff) return <NotFound />;
  if (!staff.aal2) return <NeedsTwoFactor />;

  return (
    <OpsContext.Provider value={{ token, staff }}>
      <div className="lg:grid lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav
          aria-label="Operations"
          className="border-b border-line bg-card px-3 py-3 lg:border-b-0 lg:border-r lg:py-5"
        >
          <p className="mb-2 hidden px-3 text-xs font-medium text-staff lg:block">Operations</p>
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
            {NAV.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              const count =
                item.count === "waiting"
                  ? staff.waiting
                  : item.count === "reports"
                    ? (staff.reports ?? null)
                    : null;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-3 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-selected font-medium text-selected-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {item.label}
                    {count ? <span className="text-xs tabular-nums">{count}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </OpsContext.Provider>
  );
}
