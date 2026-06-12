"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

interface StartFreeCTAProps {
  align?: "start" | "center";
  size?: "lg" | "md";
  /** Label for the secondary /go link. Pass null to hide it. */
  goCta?: string | null;
}

export function StartFreeCTA(props: StartFreeCTAProps) {
  return (
    <SupabaseAuthProvider>
      <StartFreeCTAInner {...props} />
    </SupabaseAuthProvider>
  );
}

function StartFreeCTAInner({
  align = "start",
  size = "md",
  goCta = "try without an account",
}: StartFreeCTAProps) {
  const { isAuthenticated } = useAuth();
  const alignClass = align === "center" ? "items-center text-center" : "items-start";
  // bg/text utilities repeated after neo-btn-primary so they survive the Button
  // outline variant's bg-background (utilities beat the components-layer class).
  const primaryOverride =
    "neo-btn-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground cursor-pointer";
  const buttonClass =
    size === "lg"
      ? `h-12 text-base px-6 ${primaryOverride}`
      : `h-11 text-sm px-5 ${primaryOverride}`;

  // Signed-out is the default branch so the CTA is part of the prerendered
  // HTML; authenticated visitors see it swap to the dashboard link.
  if (isAuthenticated) {
    return (
      <div className={`flex flex-col gap-3 ${alignClass}`}>
        <Link
          href="/dashboard"
          className={`neo-btn-primary inline-block ${size === "lg" ? "text-lg px-6 py-3" : ""}`}
        >
          Go to Dashboard
          <ArrowRight className="inline-block ml-2 h-5 w-5" />
        </Link>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${alignClass}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`font-bold ${size === "lg" ? "text-base" : "text-sm"}`}>Start free:</span>
        <OAuthSignInButtons
          redirectTo="/dashboard"
          layout="horizontal"
          buttonClassName={buttonClass}
        />
      </div>
      {goCta ? (
        <p className="text-sm text-muted-foreground">
          No credit card &middot; 50 requests/day free &middot; or{" "}
          <Link
            href="/go"
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick("try_live")}
          >
            {goCta}
            <ArrowRight className="inline-block ml-1 h-4 w-4" />
          </Link>
        </p>
      ) : null}
    </div>
  );
}
