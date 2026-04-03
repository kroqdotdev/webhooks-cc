"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { EndpointSwitcher } from "./endpoint-switcher";
import { resetUser, trackSignOut } from "@/lib/analytics";

export function DashboardHeader() {
  const router = useRouter();

  const handleSignOut = async () => {
    trackSignOut();
    resetUser();
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
  };

  return (
    <header className="border-b">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="font-bold text-xl">
            webhooks.cc
          </Link>

          <EndpointSwitcher />

          <Button size="sm" asChild>
            <Link href="/endpoints/new">New Endpoint</Link>
          </Button>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/account" className="text-sm text-muted-foreground hover:text-foreground">
            Account
          </Link>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
