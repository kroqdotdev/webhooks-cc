"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { trackCTAClick } from "@/lib/analytics";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { useSite } from "@/components/providers/site-provider";

/**
 * Each site's pitch: guests on webhooks.cc can try a URL without an account,
 * while mailhooks.cc's email needs one (guest endpoints get no mail), so it
 * points at the layout gallery instead.
 */
const COPY = {
  webhooks: {
    title: "Start testing webhooks",
    text: "Free account. 50 requests/day. CLI, SDK, and MCP included.",
    other: { href: "/", label: "try without an account", event: "try_live" },
  },
  mailhooks: {
    title: "Start turning email into data",
    text: "Free account. 50 emails a day, with layouts and destinations included.",
    other: { href: "/parse", label: "browse the layout gallery", event: "layout_gallery" },
  },
} as const;

export function DocsCTA() {
  return (
    <SupabaseAuthProvider>
      <DocsCTAInner />
    </SupabaseAuthProvider>
  );
}

function DocsCTAInner() {
  const { isAuthenticated, isLoading } = useAuth();
  const copy = COPY[useSite().key];

  // Don't show CTA to authenticated users
  if (isLoading || isAuthenticated) return null;

  return (
    <div className="mt-16 pt-8 border-t border-border">
      <div className="ui-card ui-card-static bg-muted">
        <p className="font-bold text-lg mb-1">{copy.title}</p>
        <p className="text-sm text-muted-foreground mb-4">{copy.text}</p>
        <div className="flex flex-wrap items-center gap-3">
          <OAuthSignInButtons
            redirectTo="/dashboard"
            layout="horizontal"
            buttonClassName="h-9 text-sm px-4 ui-btn-outline cursor-pointer"
          />
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          or{" "}
          <Link
            href={copy.other.href}
            className="text-foreground font-bold hover:text-primary transition-colors"
            onClick={() => trackCTAClick(copy.other.event)}
          >
            {copy.other.label}
            <ArrowRight className="inline-block ml-1 h-3.5 w-3.5" />
          </Link>
        </p>
      </div>
    </div>
  );
}
