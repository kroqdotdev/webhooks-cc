"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { EndpointSwitcher } from "@/components/dashboard/endpoint-switcher";
import { NewEndpointDialog } from "@/components/dashboard/new-endpoint-dialog";
import { ArrowLeft, Menu, X } from "lucide-react";
import { resetUser } from "@/lib/analytics";

interface AppHeaderProps {
  showEndpointSwitcher?: boolean;
  showNewEndpoint?: boolean;
  showBackToDashboard?: boolean;
  showBlogLink?: boolean;
}

export function AppHeader({
  showEndpointSwitcher = false,
  showNewEndpoint = false,
  showBackToDashboard = false,
  showBlogLink = true,
}: AppHeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close mobile menu on route change (e.g. browser back)
  useEffect(() => setOpen(false), [pathname]);

  const handleSignOut = async () => {
    resetUser();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  return (
    <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50 relative">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-bold text-lg">
            webhooks.cc
          </Link>

          {showBackToDashboard && (
            <Link
              href="/dashboard"
              className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Link>
          )}

          {showEndpointSwitcher && <EndpointSwitcher />}

          {showNewEndpoint && <NewEndpointDialog />}
        </div>

        {/* Desktop */}
        <div className="hidden md:flex items-center gap-3">
          <Link href="/docs" className="text-sm text-muted-foreground hover:text-foreground">
            Docs
          </Link>
          <Link
            href="/installation"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Install
          </Link>
          {showBlogLink && (
            <Link href="/blog" className="text-sm text-muted-foreground hover:text-foreground">
              Blog
            </Link>
          )}
          <ThemeToggle />
          <Link href="/account" className="text-sm text-muted-foreground hover:text-foreground">
            Account
          </Link>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
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
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="absolute md:hidden top-full left-0 right-0 border-t-2 border-foreground bg-background shadow-neo z-50">
          <div className="px-4 py-4 flex flex-col gap-3">
            <Link
              href="/docs"
              className="text-foreground font-medium text-lg"
              onClick={() => setOpen(false)}
            >
              Docs
            </Link>
            <Link
              href="/installation"
              className="text-foreground font-medium text-lg"
              onClick={() => setOpen(false)}
            >
              Install
            </Link>
            {showBlogLink && (
              <Link
                href="/blog"
                className="text-foreground font-medium text-lg"
                onClick={() => setOpen(false)}
              >
                Blog
              </Link>
            )}
            <Link
              href="/account"
              className="text-foreground font-medium text-lg"
              onClick={() => setOpen(false)}
            >
              Account
            </Link>
            <div className="pt-3 border-t-2 border-foreground/20">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-lg font-medium p-0 h-auto"
                onClick={() => {
                  setOpen(false);
                  void handleSignOut();
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
