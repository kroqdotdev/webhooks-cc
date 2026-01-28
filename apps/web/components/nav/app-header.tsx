"use client";

import Link from "next/link";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { EndpointSwitcher } from "@/components/dashboard/endpoint-switcher";
import { NewEndpointDialog } from "@/components/dashboard/new-endpoint-dialog";

interface AppHeaderProps {
  showEndpointSwitcher?: boolean;
  showNewEndpoint?: boolean;
  backLink?: {
    href: string;
    label: string;
  };
}

export function AppHeader({
  showEndpointSwitcher = false,
  showNewEndpoint = false,
  backLink,
}: AppHeaderProps) {
  const { signOut } = useAuthActions();

  return (
    <header className="border-b-2 border-foreground shrink-0">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="font-bold text-lg">
            webhooks.cc
          </Link>

          {showEndpointSwitcher && <EndpointSwitcher />}

          {showNewEndpoint && <NewEndpointDialog />}
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          {backLink ? (
            <Link
              href={backLink.href}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {backLink.label}
            </Link>
          ) : (
            <Link
              href="/account"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Account
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
