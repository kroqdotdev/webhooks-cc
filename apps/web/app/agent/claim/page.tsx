"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { getMaintenanceTopOffset } from "@/lib/announcements";
import { createClient } from "@/lib/supabase/client";

/**
 * Where an agent sends its human to connect it to their account (auth.md
 * v0.6 claim ceremony). The link carries the attempt token; the human signs
 * in, checks what is asking, and types the 6-digit code the agent shows.
 * Nothing from the URL is rendered: every label comes from the server.
 */

interface AttemptView {
  state: "pending" | "expired" | "denied" | "locked";
  clientName: string | null;
  kind: "anonymous" | "service_auth" | "identity_assertion";
  provider: string | null;
  registeredAt: number;
  attemptExpiresAt: number | null;
  requestedFor: string;
  signedInAs: string | null;
  emailMatches: boolean;
  codesLeft: number;
  firstAgent: boolean;
  endpoints: { slug: string; requestCount: number }[];
}

type Phase =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "view"; view: AttemptView }
  | { kind: "connected"; adopted: string[] }
  | { kind: "declined" };

export default function AgentClaimPage() {
  return (
    <SupabaseAuthProvider>
      <Suspense fallback={<Loading />}>
        <AgentClaimContent />
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

function AgentClaimContent() {
  const { isAuthenticated, isLoading, session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const attempt = searchParams.get("attempt") ?? "";
  const accessToken = session?.access_token;

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = `/agent/claim${window.location.search}`;
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    if (!attempt) {
      setPhase({ kind: "missing" });
      return;
    }
    try {
      const response = await fetch(
        `/api/agent/identity/claim/attempt?attempt=${encodeURIComponent(attempt)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (response.status === 404) {
        setPhase({ kind: "missing" });
        return;
      }
      if (!response.ok) throw new Error();
      setPhase({ kind: "view", view: (await response.json()) as AttemptView });
    } catch {
      setPhase({ kind: "error", message: "Could not load this request. Reload the page." });
    }
  }, [accessToken, attempt]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (path: string, body: Record<string, string>) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      body: (await response.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
        remaining?: number;
        adopted?: string[];
      },
    };
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setCodeError(null);
    try {
      const result = await post("/api/agent/identity/claim/complete", {
        claim_attempt_token: attempt,
        user_code: code,
      });
      if (result.ok) {
        setPhase({ kind: "connected", adopted: result.body.adopted ?? [] });
      } else if (result.body.error === "wrong_code") {
        setCodeError(
          `That code is not right. ${result.body.remaining} ${
            result.body.remaining === 1 ? "try" : "tries"
          } left.`
        );
        setCode("");
      } else {
        await load();
        setCodeError(result.body.error_description ?? "Could not connect the agent.");
      }
    } catch {
      setCodeError("Could not connect the agent. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    try {
      const result = await post("/api/agent/identity/claim/deny", {
        claim_attempt_token: attempt,
      });
      if (result.ok) setPhase({ kind: "declined" });
      else setCodeError(result.body.error_description ?? "Could not decline the request.");
    } finally {
      setSubmitting(false);
    }
  };

  const switchAccount = async () => {
    await createClient().auth.signOut();
    const here = `/agent/claim${window.location.search}`;
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
            <div className="flex items-center gap-6">
              <ThemeToggle />
              <Link href="/dashboard" className="ui-btn-outline text-sm py-2 px-4 w-28 text-center">
                Dashboard
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-4 pt-28 pb-12">
        <div className="w-full max-w-md" data-testid="agent-claim">
          {phase.kind === "loading" && <Loading />}

          {phase.kind === "missing" && (
            <Notice title="This link does not work">
              It is unknown, was already used, or the agent has since started a newer request. Ask
              the agent for a new link and code.
            </Notice>
          )}

          {phase.kind === "error" && <Notice title="Something went wrong">{phase.message}</Notice>}

          {phase.kind === "declined" && (
            <Notice title="Request declined">
              The agent was told you declined. Nothing was connected.
            </Notice>
          )}

          {phase.kind === "connected" && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">Agent connected</h1>
              <p className="text-muted-foreground mb-4">
                The agent can now use webhooks.cc on your behalf. You can disconnect it at any time
                under Connected agents in your account.
              </p>
              {phase.adopted.length > 0 && (
                <p className="text-sm text-muted-foreground mb-6">
                  Moved into your account:{" "}
                  <span className="font-mono">{phase.adopted.join(", ")}</span>
                </p>
              )}
              <div className="flex justify-center gap-3">
                <Link href="/dashboard" className="ui-btn-outline text-sm py-2 px-4">
                  Dashboard
                </Link>
                <Link href="/account#connected-agents" className="ui-btn-outline text-sm py-2 px-4">
                  Connected agents
                </Link>
              </div>
            </div>
          )}

          {phase.kind === "view" && (
            <AttemptPanel
              view={phase.view}
              code={code}
              setCode={setCode}
              codeError={codeError}
              submitting={submitting}
              onConnect={connect}
              onDecline={decline}
              onSwitchAccount={switchAccount}
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
      <Link href="/docs/agents" className="ui-btn-outline text-sm py-2 px-4 inline-block">
        How agents use webhooks.cc
      </Link>
    </div>
  );
}

function AttemptPanel(props: {
  view: AttemptView;
  code: string;
  setCode: (code: string) => void;
  codeError: string | null;
  submitting: boolean;
  onConnect: (event: React.FormEvent) => void;
  onDecline: () => void;
  onSwitchAccount: () => void;
}) {
  const { view } = props;

  if (view.state === "expired") {
    return (
      <Notice title="This code expired">
        Ask the agent for a new link and code. It can start a new request.
      </Notice>
    );
  }
  if (view.state === "denied") {
    return <Notice title="Request declined">You declined this request.</Notice>;
  }
  if (view.state === "locked") {
    return (
      <Notice title="Too many wrong codes">
        This request is locked. Ask the agent to start a new one.
      </Notice>
    );
  }

  if (!view.emailMatches) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-3">Wrong account</h1>
        <p className="text-muted-foreground mb-6">
          This agent asked to connect to <span className="font-mono">{view.requestedFor}</span>. You
          are signed in as <span className="font-mono">{view.signedInAs ?? "another user"}</span>.
        </p>
        <Button type="button" variant="outline" onClick={props.onSwitchAccount}>
          Sign in with another account
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-center">Connect an agent</h1>
      {view.provider ? (
        <p className="text-muted-foreground mb-6 text-center">
          <span className="font-medium text-foreground">{view.provider}</span> is asking to link
          this account so the agent it runs can act on your behalf as{" "}
          <span className="font-mono">{view.signedInAs}</span>.
        </p>
      ) : (
        <p className="text-muted-foreground mb-6 text-center">
          An AI agent asks to use webhooks.cc as{" "}
          <span className="font-mono">{view.signedInAs}</span>.
        </p>
      )}

      <dl className="ui-card ui-card-static p-4 mb-6 space-y-2 text-sm">
        {view.provider ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Identity provider</dt>
            <dd className="text-right font-medium break-all">{view.provider}</dd>
          </div>
        ) : (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="text-right">
              <span className="font-medium break-all">{view.clientName ?? "Unnamed agent"}</span>
              <span className="block text-xs text-muted-foreground">name given by the agent</span>
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Registered</dt>
          <dd>{new Date(view.registeredAt).toLocaleString()}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Gets</dt>
          <dd className="text-right">API access to your webhooks.cc account</dd>
        </div>
        {view.endpoints.length > 0 && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Moves in</dt>
            <dd className="text-right font-mono">
              {view.endpoints.map((endpoint) => (
                <span key={endpoint.slug} className="block">
                  {endpoint.slug} ({endpoint.requestCount})
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {view.firstAgent && (
        <p className="text-sm text-muted-foreground mb-4">
          This is the first agent you connect. It can do what an API key can: manage your endpoints
          and read what they capture. It cannot change your API keys, billing or account.
        </p>
      )}
      <p className="text-sm font-medium mb-4">
        Only enter a code from an agent you trust and are using right now.
      </p>

      {props.codeError && (
        <div
          className="text-sm text-destructive bg-destructive/10 p-3 rounded-md mb-4"
          role="alert"
        >
          {props.codeError}
        </div>
      )}

      <form onSubmit={props.onConnect} className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium">Code from the agent</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={props.code}
            onChange={(event) =>
              props.setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))
            }
            placeholder="123456"
            maxLength={6}
            autoFocus
            disabled={props.submitting}
            className="ui-input mt-1 w-full text-center text-2xl tracking-[0.3em] font-mono px-4 py-3"
          />
        </label>
        <Button
          type="submit"
          className="w-full h-12 text-base"
          disabled={props.code.length !== 6 || props.submitting}
        >
          {props.submitting ? <span className="animate-pulse">Connecting...</span> : "Connect"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={props.onDecline}
          disabled={props.submitting}
        >
          Decline
        </Button>
      </form>
    </div>
  );
}
