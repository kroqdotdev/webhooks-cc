"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { trackSignInStarted } from "@/lib/analytics";
import { GitHubIcon, GoogleIcon } from "@/components/ui/icons";

type Provider = "github" | "google";

export function OAuthSignInButtons({
  redirectTo = "/dashboard",
  buttonClassName = "w-full h-12 text-base",
  layout = "vertical",
  verb,
  firstButtonClassName,
  raised = false,
}: {
  redirectTo?: string;
  buttonClassName?: string;
  layout?: "vertical" | "horizontal";
  /** Words before the provider in the horizontal layout, e.g. "Sign up with". */
  verb?: string;
  /** Classes for the first (GitHub) button instead of buttonClassName; it becomes a filled, primary button. */
  firstButtonClassName?: string;
  /** Lifted by the surface shadow, like the site's other call-to-action buttons. */
  raised?: boolean;
}) {
  const label = (name: string) =>
    layout === "horizontal" ? (verb ? `${verb} ${name}` : name) : `Continue with ${name}`;
  const isAuthenticated = useIsAuthenticated();
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async (provider: Provider) => {
    setSigningIn(provider);
    setError(null);
    trackSignInStarted(provider);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
        },
      });
      if (error) {
        setError("Sign in failed. Please try again.");
        setSigningIn(null);
      }
    } catch {
      setError("Sign in failed. Please try again.");
      setSigningIn(null);
    }
  };

  // Render the buttons while auth state is still resolving so they are part
  // of the prerendered HTML — sign-in works regardless of the pending check.
  if (isAuthenticated) {
    return (
      <div className="flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      {error ? (
        <div className="text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3 mb-4">
          {error}
        </div>
      ) : null}

      <div className={layout === "horizontal" ? "flex flex-wrap items-center gap-2" : "space-y-3"}>
        <Button
          variant={firstButtonClassName ? "default" : "outline"}
          raised={raised}
          className={firstButtonClassName ?? buttonClassName}
          onClick={() => handleSignIn("github")}
          disabled={signingIn !== null}
        >
          {signingIn === "github" ? (
            <span className="animate-pulse">Signing in...</span>
          ) : (
            <>
              <GitHubIcon className={layout === "horizontal" ? "mr-1.5 h-4 w-4" : "mr-2 h-5 w-5"} />
              {label("GitHub")}
            </>
          )}
        </Button>

        <Button
          variant="outline"
          raised={raised}
          className={buttonClassName}
          onClick={() => handleSignIn("google")}
          disabled={signingIn !== null}
        >
          {signingIn === "google" ? (
            <span className="animate-pulse">Signing in...</span>
          ) : (
            <>
              <GoogleIcon className={layout === "horizontal" ? "mr-1.5 h-4 w-4" : "mr-2 h-5 w-5"} />
              {label("Google")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
