"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { getMaintenanceTopOffset } from "@/lib/announcements";
import { createClient } from "@/lib/supabase/client";

/**
 * The OAuth authorization endpoint: where a remote MCP client (claude.ai,
 * ChatGPT, an IDE) sends its human to connect webhooks.cc. The human signs
 * in, sees which app asks, and approves or declines; there is no code to
 * type. Every label comes from the server, which checks the request again
 * when the human decides; nothing from the URL is rendered.
 */

interface RequestView {
  client: {
    name: string | null;
    verifiedHost: string | null;
    clientUri: string | null;
    kind: "metadata_document" | "registered";
  };
  redirectHost: string;
  scope: string;
  signedInAs: string | null;
  connectedAgents: number;
  maxAgents: number;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; title: string; message: string }
  | { kind: "view"; view: RequestView }
  | { kind: "leaving"; approved: boolean };

export default function OAuthAuthorizePage() {
  return (
    <SupabaseAuthProvider>
      <Suspense fallback={<Loading />}>
        <AuthorizeContent />
      </Suspense>
    </SupabaseAuthProvider>
  );
}

function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

function AuthorizeContent() {
  const { isAuthenticated, isLoading, session } = useAuth();
  const router = useRouter();
  const accessToken = session?.access_token;

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = `/oauth/authorize${window.location.search}`;
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch(`/api/oauth2/authorize${window.location.search}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      } & Partial<RequestView>;
      if (response.ok) {
        setPhase({ kind: "view", view: body as RequestView });
      } else {
        setPhase({
          kind: "error",
          title: "This link does not work",
          message:
            body.error_description ??
            "The app sent an incomplete request. Connect again from the app.",
        });
      }
    } catch {
      setPhase({
        kind: "error",
        title: "Something went wrong",
        message: "Could not load this request. Reload the page.",
      });
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (decision: "approve" | "deny") => {
    setSubmitting(true);
    setProblem(null);
    try {
      const params = Object.fromEntries(new URLSearchParams(window.location.search));
      const response = await fetch("/api/oauth2/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ ...params, decision }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        redirect?: string;
        error_description?: string;
      };
      if (body.redirect) {
        setPhase({ kind: "leaving", approved: decision === "approve" });
        window.location.assign(body.redirect);
        return;
      }
      setProblem(body.error_description ?? "Could not complete the request. Try again.");
    } catch {
      setProblem("Could not complete the request. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  };

  const switchAccount = async () => {
    await createClient().auth.signOut();
    const here = `/oauth/authorize${window.location.search}`;
    router.push(`/login?redirect=${encodeURIComponent(here)}`);
  };

  if (isLoading || !isAuthenticated) return <Loading />;

  return (
    <div className="min-h-screen flex flex-col">
      <nav
        className="fixed left-4 right-4 z-50"
        style={{ top: `calc(${getMaintenanceTopOffset()} + var(--ann-h, 0px))` }}
      >
        <div className="max-w-6xl mx-auto rounded-lg border-strong border-line bg-background shadow-raised">
          <div className="px-6 h-16 flex items-center justify-between">
            <Link href="/" className="font-bold text-xl tracking-tight">
              webhooks.cc
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-28 pb-12">
        <div className="w-full max-w-md" data-testid="oauth-authorize">
          {phase.kind === "loading" && <Loading />}

          {phase.kind === "error" && <Notice title={phase.title}>{phase.message}</Notice>}

          {phase.kind === "leaving" && (
            <Notice title={phase.approved ? "Connected" : "Declined"}>
              Taking you back to the app. You can close this tab if nothing happens.
            </Notice>
          )}

          {phase.kind === "view" && (
            <RequestPanel
              view={phase.view}
              problem={problem}
              submitting={submitting}
              onApprove={() => void decide("approve")}
              onDeny={() => void decide("deny")}
              onSwitchAccount={() => void switchAccount()}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold mb-3">{title}</h1>
      <p className="text-muted-foreground mb-6">{children}</p>
      <Link href="/docs/mcp" className="ui-btn-outline text-sm py-2 px-4 inline-block">
        How apps connect to webhooks.cc
      </Link>
    </div>
  );
}

function RequestPanel(props: {
  view: RequestView;
  problem: string | null;
  submitting: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onSwitchAccount: () => void;
}) {
  const { view } = props;
  const name = view.client.name ?? view.client.verifiedHost ?? "An app";
  const atCap = view.connectedAgents >= view.maxAgents;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-center">Connect {name}</h1>
      <p className="text-muted-foreground mb-6 text-center">
        <span className="font-medium text-foreground">{name}</span> asks to use webhooks.cc as{" "}
        <span className="font-mono">{view.signedInAs ?? "you"}</span>.
      </p>

      <dl className="ui-card ui-card-static p-4 mb-6 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">App</dt>
          <dd className="text-right">
            <span className="font-medium break-all">{name}</span>
            <span className="block text-xs text-muted-foreground">
              {view.client.verifiedHost
                ? `identified by ${view.client.verifiedHost}`
                : "name given by the app, not verified"}
            </span>
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Returns to</dt>
          <dd className="text-right font-mono break-all">{view.redirectHost}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Gets</dt>
          <dd className="text-right">
            API access to your webhooks.cc account: your endpoints and what they capture
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted-foreground mb-4">
        It cannot change your API keys, billing or account. It stays connected until you disconnect
        it under Connected agents in your account, or it goes unused for 90 days.
      </p>

      {atCap ? (
        <div
          className="text-sm text-destructive bg-destructive/10 p-3 rounded-md mb-4"
          role="alert"
        >
          You have {view.connectedAgents} connected agents, the most an account can have.{" "}
          <Link href="/account/agents" className="underline">
            Disconnect one
          </Link>{" "}
          and reload this page.
        </div>
      ) : (
        <p className="text-sm font-medium mb-4">
          Only connect an app you trust and started connecting just now.
        </p>
      )}

      {props.problem && (
        <div
          className="text-sm text-destructive bg-destructive/10 p-3 rounded-md mb-4"
          role="alert"
        >
          {props.problem}
        </div>
      )}

      <div className="space-y-3">
        <Button
          type="button"
          className="w-full h-12 text-base"
          onClick={props.onApprove}
          disabled={props.submitting || atCap}
        >
          {props.submitting ? <span className="animate-pulse">Connecting...</span> : "Connect"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={props.onDeny}
          disabled={props.submitting}
        >
          Decline
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full text-sm"
          onClick={props.onSwitchAccount}
          disabled={props.submitting}
        >
          Use another account
        </Button>
      </div>
    </div>
  );
}
