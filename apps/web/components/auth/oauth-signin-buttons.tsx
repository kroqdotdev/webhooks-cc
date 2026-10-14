"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useIsAuthenticated } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { trackSignInStarted } from "@/lib/analytics";
import { GoogleIcon } from "@/components/ui/icons";

type Provider = "github" | "google";

export function OAuthSignInButtons({
  redirectTo = "/dashboard",
  buttonClassName = "w-full h-12 text-base",
  layout = "vertical",
}: {
  redirectTo?: string;
  buttonClassName?: string;
  layout?: "vertical" | "horizontal";
}) {
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
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950 p-3 rounded mb-4">
          {error}
        </div>
      ) : null}

      <div className={layout === "horizontal" ? "flex flex-wrap items-center gap-2" : "space-y-3"}>
        <Button
          variant="outline"
          className={buttonClassName}
          onClick={() => handleSignIn("github")}
          disabled={signingIn !== null}
        >
          {signingIn === "github" ? (
            <span className="animate-pulse">Signing in...</span>
          ) : (
            <>
              <GitHubIcon className={layout === "horizontal" ? "mr-1.5 h-4 w-4" : "mr-2 h-5 w-5"} />
              {layout === "horizontal" ? "GitHub" : "Continue with GitHub"}
            </>
          )}
        </Button>

        <Button
          variant="outline"
          className={buttonClassName}
          onClick={() => handleSignIn("google")}
          disabled={signingIn !== null}
        >
          {signingIn === "google" ? (
            <span className="animate-pulse">Signing in...</span>
          ) : (
            <>
              <GoogleIcon className={layout === "horizontal" ? "mr-1.5 h-4 w-4" : "mr-2 h-5 w-5"} />
              {layout === "horizontal" ? "Google" : "Continue with Google"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
