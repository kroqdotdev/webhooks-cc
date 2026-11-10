"use client";

import Link from "next/link";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import {
  SupabaseAuthProvider,
  useIsAuthenticated,
} from "@/components/providers/supabase-auth-provider";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PricingCTAProps {
  /** On a dark (inverted) card: the buttons and the email link use the card's colours. */
  inverted?: boolean;
  /** Make the first button the page's primary action. */
  primary?: boolean;
  /** Where the email link sits: centred under both buttons, or under the first. */
  emailAlign?: "center" | "start";
  /** In a pricing card beside an Upgrade button, the signed-in Dashboard link steps back. */
  quietWhenSignedIn?: boolean;
}

export function PricingCTA(props: PricingCTAProps) {
  return (
    <SupabaseAuthProvider>
      <PricingCTAInner {...props} />
    </SupabaseAuthProvider>
  );
}

function PricingCTAInner({
  inverted = false,
  primary = false,
  emailAlign = "center",
  quietWhenSignedIn = false,
}: PricingCTAProps) {
  const isAuthenticated = useIsAuthenticated();

  // Signed-out is the default branch so the CTA is part of the prerendered
  // HTML; authenticated visitors see it swap to the dashboard link.
  if (isAuthenticated) {
    return (
      <Link
        href="/dashboard"
        className={cn(
          quietWhenSignedIn ? "ui-btn-outline" : "ui-btn-primary",
          "w-full text-center block"
        )}
      >
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
        verb="Sign up with"
        buttonClassName={cn(
          "text-sm px-4 ui-btn-outline cursor-pointer flex-1 whitespace-nowrap normal-case tracking-normal",
          inverted && "text-foreground"
        )}
        firstButtonClassName={
          primary
            ? "text-sm px-4 ui-btn-primary cursor-pointer flex-1 whitespace-nowrap normal-case tracking-normal"
            : undefined
        }
      />
      <Link
        href="/login?mode=sign-up"
        className={cn(
          "block text-sm underline underline-offset-4 py-2",
          emailAlign === "start" ? "text-left" : "text-center",
          inverted
            ? "text-background hover:text-background/80"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        or sign up with email
      </Link>
    </div>
  );
}

/**
 * The button on a paid plan's card. Everyone starts free, so a visitor signs
 * up first and upgrades later; someone already signed in goes straight to
 * Plan and usage to upgrade.
 */
export function PaidPlanCTA({
  plan,
  primary = false,
}: {
  plan: "Pro" | "Business";
  primary?: boolean;
}) {
  return (
    <SupabaseAuthProvider>
      <PaidPlanCTAInner plan={plan} primary={primary} />
    </SupabaseAuthProvider>
  );
}

function PaidPlanCTAInner({ plan, primary }: { plan: "Pro" | "Business"; primary: boolean }) {
  const isAuthenticated = useIsAuthenticated();
  return (
    <Link
      href={isAuthenticated ? "/account/plan" : "/login?mode=sign-up&redirect=/account/plan"}
      className={cn(primary ? "ui-btn-primary" : "ui-btn-outline", "mt-auto block text-center")}
    >
      {isAuthenticated ? `Upgrade to ${plan}` : `Start free, then go ${plan}`}
    </Link>
  );
}
