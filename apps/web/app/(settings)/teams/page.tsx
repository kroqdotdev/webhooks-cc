"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import {
  InlineMessage,
  Notice,
  Panel,
  SettingsPageHeader,
  SettingsPageSkeleton,
  StatusTag,
} from "@/components/settings/panel";
import { QuotaMeter, type SeatSlot } from "@/components/settings/quota-meter";
import { useSettingsData } from "@/components/settings/settings-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  trackTeamCreated,
  trackTeamInviteAccepted,
  trackTeamInviteDeclined,
} from "@/lib/analytics";
import type { Team } from "@/lib/supabase/teams-types";
import { TEAM_SEAT_PRICE_USD } from "@/lib/team-pricing";

/** Shown when accepting fails for a reason the API could not name (500, network). */
const GENERIC_ACCEPT_ERROR =
  "No seat could be claimed. Try again, or ask the owner to check seats.";

/** The compact rail draws at most this many seat blocks; the fill stays proportional. */
const LIST_SEAT_BLOCKS = 20;

function teamStatus(team: Team): { tone: "warning" | "danger"; label: string } | null {
  if (team.suspended) return { tone: "warning", label: "Suspended" };
  if (team.subscriptionStatus === "past_due") return { tone: "danger", label: "Payment past due" };
  if (team.cancelAtPeriodEnd) return { tone: "warning", label: "Cancels at period end" };
  return null;
}

function NewTeamDialog({ onCreated }: { onCreated: (teamId: string | null) => Promise<void> }) {
  const { session } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The side nav's "New team" links here with ?new=1.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setOpen(true);
      router.replace("/teams", { scroll: false });
    }
  }, [searchParams, router]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || !session?.access_token) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        trackTeamCreated();
        const created = (await res.json().catch(() => null)) as { id?: string } | null;
        setName("");
        setOpen(false);
        await onCreated(created?.id ?? null);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "The team was not created. Try again.");
      }
    } catch {
      setError("The team was not created. Check your connection.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New team</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>
            You can invite people once it has a subscription. You choose the number of seats then.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <Label htmlFor="new-team-name">Team name</Label>
          <Input
            id="new-team-name"
            placeholder="Payments squad"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            autoFocus
          />
          {error && <InlineMessage tone="error">{error}</InlineMessage>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamsContent() {
  const { session } = useAuth();
  const router = useRouter();
  const { teams, invites, loading, loadError, refresh } = useSettingsData();

  // Re-read on every visit so member counts, status and usage are current.
  useEffect(() => {
    void refresh({ reuse: true });
  }, [refresh]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<{ inviteId: string; message: string } | null>(
    null
  );

  const authHeader: Record<string, string> = session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};

  const handleAccept = async (inviteId: string) => {
    setAcceptingId(inviteId);
    setInviteError(null);
    try {
      const res = await fetch(`/api/invites/${inviteId}/accept`, {
        method: "POST",
        headers: authHeader,
      });
      if (res.ok) {
        trackTeamInviteAccepted();
        await refresh();
        return;
      }
      // 400s name the reason (inactive team, no free seat); a 500 means the seat
      // claim itself broke, which has no message worth repeating verbatim.
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setInviteError({
        inviteId,
        message: res.status >= 500 || !data.error ? GENERIC_ACCEPT_ERROR : data.error,
      });
    } catch {
      setInviteError({ inviteId, message: GENERIC_ACCEPT_ERROR });
    } finally {
      setAcceptingId(null);
    }
  };

  const handleDecline = async (inviteId: string) => {
    setDecliningId(inviteId);
    setInviteError(null);
    try {
      const res = await fetch(`/api/invites/${inviteId}/decline`, {
        method: "POST",
        headers: authHeader,
      });
      if (res.ok) {
        trackTeamInviteDeclined();
        await refresh();
      } else {
        setInviteError({ inviteId, message: "The invite was not declined. Try again." });
      }
    } catch {
      setInviteError({ inviteId, message: "The invite was not declined. Try again." });
    } finally {
      setDecliningId(null);
    }
  };

  const header = (
    <SettingsPageHeader
      title="Teams"
      description={`Share endpoints with the people you work with. Each seat is $${TEAM_SEAT_PRICE_USD} a month and adds 100,000 requests to the team's shared pool.`}
      actions={
        <NewTeamDialog
          onCreated={async (teamId) => {
            await refresh();
            if (teamId) router.push(`/teams/${teamId}`);
          }}
        />
      }
    />
  );

  if (loading) {
    return <SettingsPageSkeleton label="Loading teams" />;
  }

  if (loadError && teams.length === 0) {
    return (
      <>
        {header}
        <Notice
          tone="danger"
          title="Your teams could not be loaded"
          action={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const suspendedOwned = teams.filter((t) => t.role === "owner" && t.suspended);

  return (
    <>
      {header}

      <div className="space-y-6">
        {invites.length > 0 && (
          <Panel id="invites" title="Invites" flush>
            <ul>
              {invites.map((invite) => {
                const busy = acceptingId === invite.id || decliningId === invite.id;
                return (
                  <li
                    key={invite.id}
                    className="space-y-2 border-b border-line/60 px-5 py-4 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{invite.teamName}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          Invited by {invite.inviterEmail}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => void handleAccept(invite.id)}
                          disabled={busy}
                        >
                          {acceptingId === invite.id ? "Accepting..." : "Accept"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleDecline(invite.id)}
                          disabled={busy}
                        >
                          {decliningId === invite.id ? "Declining..." : "Decline"}
                        </Button>
                      </div>
                    </div>
                    {inviteError?.inviteId === invite.id && (
                      <InlineMessage tone="error">{inviteError.message}</InlineMessage>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        {suspendedOwned.length > 0 && (
          <Notice
            tone="warning"
            title={
              suspendedOwned.length === 1
                ? `${suspendedOwned[0].name} is suspended`
                : "Some of your teams are suspended"
            }
          >
            A suspended team has no subscription, so its members cannot open shared endpoints. Open
            the team and subscribe to restore access.
          </Notice>
        )}

        {teams.length === 0 ? (
          <Panel
            id="no-teams"
            title="You're not in a team yet"
            description={`Create a team to share endpoints with teammates. Teams are $${TEAM_SEAT_PRICE_USD} a seat each month, and every seat adds 100,000 requests to the team's shared pool.`}
          />
        ) : (
          <Panel id="your-teams" title="Your teams" flush>
            <ul>
              {teams.map((team) => {
                const status = teamStatus(team);
                const blocks: SeatSlot[] = Array.from(
                  { length: Math.max(1, Math.min(team.seats, LIST_SEAT_BLOCKS)) },
                  () => ({ kind: "open" })
                );
                return (
                  <li key={team.id} className="border-b border-line/60 last:border-b-0">
                    <Link
                      href={`/teams/${team.id}`}
                      aria-label={`${team.role === "owner" ? "Manage" : "View"} ${team.name}`}
                      className="grid gap-3 px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-center sm:gap-8"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium">{team.name}</p>
                          {status && <StatusTag tone={status.tone}>{status.label}</StatusTag>}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {team.role === "owner" ? "Owner" : "Member"}
                          {", "}
                          {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
                          {team.seats > 0 && ` of ${team.seats} seats`}
                        </p>
                      </div>
                      {team.suspended ? (
                        <p className="text-sm text-muted-foreground sm:text-right">
                          {team.role === "owner"
                            ? "Subscribe to activate"
                            : "Waiting for the owner to subscribe"}
                        </p>
                      ) : (
                        <div className="space-y-1">
                          <QuotaMeter
                            used={team.requestsUsed}
                            limit={team.requestLimit}
                            seats={blocks}
                            compact
                            label="pooled requests"
                          />
                          <p className="text-xs text-muted-foreground tabular-nums">
                            {team.requestsUsed.toLocaleString()} of{" "}
                            {team.requestLimit.toLocaleString()} requests
                          </p>
                        </div>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

export default function TeamsPage() {
  // The new-team dialog reads ?new=1, which needs a Suspense boundary.
  return (
    <Suspense fallback={<SettingsPageSkeleton label="Loading teams" />}>
      <TeamsContent />
    </Suspense>
  );
}
