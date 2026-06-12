"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

export function HeroCTA() {
  return (
    <SupabaseAuthProvider>
      <HeroCTAInner />
    </SupabaseAuthProvider>
  );
}

function HeroCTAInner() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <div className="h-[7.5rem]" />;
  }

  if (isAuthenticated) {
    return (
      <Link href="/dashboard" className="neo-btn-primary text-lg px-6 py-3 inline-block">
        Go to Dashboard
        <ArrowRight className="inline-block ml-2 h-5 w-5" />
      </Link>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href="/go"
          className="neo-btn-primary text-lg px-6 py-3"
          onClick={() => trackCTAClick("try_live")}
        >
          Get your webhook URL
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
        <span className="text-sm font-bold text-muted-foreground">
          No signup. Live in 2 seconds.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">or sign in to keep your endpoints:</span>
        <OAuthSignInButtons
          redirectTo="/dashboard"
          layout="horizontal"
          buttonClassName="h-9 text-sm px-4 neo-btn-outline cursor-pointer"
        />
      </div>
    </div>
  );
}
