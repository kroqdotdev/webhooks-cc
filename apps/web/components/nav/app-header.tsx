"use client";

import Link from "next/link";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { EndpointSwitcher } from "@/components/dashboard/endpoint-switcher";
import { NewEndpointDialog } from "@/components/dashboard/new-endpoint-dialog";
import { ArrowLeft } from "lucide-react";

interface AppHeaderProps {
  showEndpointSwitcher?: boolean;
  showNewEndpoint?: boolean;
  showBackToDashboard?: boolean;
}

export function AppHeader({
  showEndpointSwitcher = false,
  showNewEndpoint = false,
  showBackToDashboard = false,
}: AppHeaderProps) {
  const { signOut } = useAuthActions();

  return (
    <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-bold text-lg">
            webhooks.cc
          </Link>

          {showBackToDashboard && (
            <Link
              href="/dashboard"
              className="neo-btn-outline !py-1.5 !px-3 text-xs flex items-center gap-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Link>
          )}

          {showEndpointSwitcher && <EndpointSwitcher />}

          {showNewEndpoint && <NewEndpointDialog />}
        </div>

        <div className="flex items-center gap-3">
          <Link href="/docs" className="text-sm text-muted-foreground hover:text-foreground">
            Docs
          </Link>
          <Link
            href="/installation"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Install
          </Link>
          <ThemeToggle />
          <Link href="/account" className="text-sm text-muted-foreground hover:text-foreground">
            Account
          </Link>
          <Button variant="ghost" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
