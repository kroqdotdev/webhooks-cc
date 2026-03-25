"use client";

import Link from "next/link";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { ArrowRight } from "lucide-react";

export function PricingCTA() {
  return (
    <SupabaseAuthProvider>
      <PricingCTAInner />
    </SupabaseAuthProvider>
  );
}

function PricingCTAInner() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <div className="h-10" />;

  if (isAuthenticated) {
    return (
      <Link href="/dashboard" className="neo-btn-primary w-full text-center block">
        Go to Dashboard
        <ArrowRight className="inline-block ml-2 h-5 w-5" />
      </Link>
    );
  }

  return (
    <div className="space-y-2">
      <OAuthSignInButtons
        redirectTo="/dashboard"
        layout="horizontal"
        buttonClassName="h-10 text-sm px-4 neo-btn-outline cursor-pointer flex-1"
      />
    </div>
  );
}
