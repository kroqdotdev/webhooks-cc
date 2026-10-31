"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Avatar } from "@/components/settings/avatar";
import {
  InlineMessage,
  Notice,
  Panel,
  SettingsPageHeader,
  SettingsPageSkeleton,
  StatusTag,
  settingsLink,
} from "@/components/settings/panel";
import { QuotaMeter, seatSlotsFor } from "@/components/settings/quota-meter";
import { useSettingsData } from "@/components/settings/settings-data";
import { CapacityPanel } from "@/components/billing/capacity-panel";
import { ParsedPagesPanel } from "@/components/billing/parsed-pages-panel";
import { TeamBusinessPanel } from "@/components/teams/team-business-panel";
import { TeamBillingPanel } from "@/components/teams/team-billing-panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  trackEndpointTeamToggled,
  trackQuotaWarningShown,
  trackTeamDeleted,
  trackTeamLeft,
  trackTeamMemberInvited,
  trackTeamMemberRemoved,
} from "@/lib/analytics";
import type {
  TeamInvite,
  TeamMember,
  TeamSharedEndpoint as TeamEndpoint,
} from "@/lib/supabase/teams-types";
import { ACTIVATION_POLL_INTERVAL_MS, hasActivationTimedOut } from "@/lib/team-activation";
import { longDate, shortDate } from "@/components/settings/format";

interface OwnedEndpoint {
  id: string;
  slug: string;
  name?: string | null;
  sharedWith?: Array<{ teamId: string }>;
}

type Message = { tone: "success" | "warning" | "error"; text: string };

async function errorText(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.status < 500 && data.error ? data.error : fallback;
}

function TeamDetailContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const teamId = params.teamId as string;
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const currentUserId = session?.user?.id ?? null;
  const settings = useSettingsData();
  const team = settings.teams.find((t) => t.id === teamId) ?? null;

  const [members, setMembers] = useState<TeamMember[] | null>(null);
  // Bumped when Team Business changes, which the pages panel reads.
  const [businessVersion, setBusinessVersion] = useState(0);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [endpoints, setEndpoints] = useState<TeamEndpoint[]>([]);
  const [ownedEndpoints, setOwnedEndpoints] = useState<OwnedEndpoint[]>([]);
  const [detailError, setDetailError] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<Message | null>(null);
  const [cancelingInviteId, setCancelingInviteId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [sharing, setSharing] = useState<string | null>(null);
  const [endpointsError, setEndpointsError] = useState<string | null>(null);

  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameMessage, setRenameMessage] = useState<Message | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [activationTimedOut, setActivationTimedOut] = useState(false);

  // Seed the rename field from the team, and again when the saved name changes.
  const [seededName, setSeededName] = useState<string | null>(null);
  if (team && seededName !== team.name) {
    setSeededName(team.name);
    setRenameValue(team.name);
  }

  const authHeader = useCallback(
    (): Record<string, string> => (accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    [accessToken]
  );

  const loadDetails = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [membersRes, teamEndpointsRes, ownedRes] = await Promise.all([
        fetch(`/api/teams/${teamId}/members`, { headers: authHeader() }),
        fetch(`/api/teams/${teamId}/endpoints`, { headers: authHeader() }),
        fetch("/api/endpoints", { headers: authHeader() }),
      ]);
      if (!membersRes.ok) {
        setDetailError(true);
        return;
      }
      const memberData = (await membersRes.json()) as {
        members: TeamMember[];
        pendingInvites: TeamInvite[];
      };
      setMembers(memberData.members ?? []);
      setInvites(memberData.pendingInvites ?? []);
      if (teamEndpointsRes.ok) {
        const data = (await teamEndpointsRes.json()) as { endpoints: TeamEndpoint[] };
        setEndpoints(data.endpoints ?? []);
      }
      if (ownedRes.ok) {
        const data = (await ownedRes.json()) as { owned: OwnedEndpoint[] };
        setOwnedEndpoints(data.owned ?? []);
      }
      // A failed endpoints read must not pass for "nothing shared yet".
      setDetailError(!teamEndpointsRes.ok || !ownedRes.ok);
    } catch (error) {
      console.error("Failed to load team page data:", error);
      setDetailError(true);
    }
  }, [accessToken, teamId, authHeader]);

  // Clear the table only for another team: loadDetails also changes when the
  // session token refreshes, and that re-read should not flash a loading state.
  useEffect(() => {
    setMembers(null);
  }, [teamId]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  // The team row (seats, status, usage) comes from the shared list, which is
  // re-read on every visit; until that read lands, a missing team may just be
  // one joined since the list was loaded.
  const { refresh: refreshTeams } = settings;
  const [teamsSynced, setTeamsSynced] = useState(false);
  useEffect(() => {
    let current = true;
    setTeamsSynced(false);
    void refreshTeams({ reuse: true }).finally(() => {
      if (current) setTeamsSynced(true);
    });
    return () => {
      current = false;
    };
  }, [teamId, refreshTeams]);

  // ── Post-checkout activation wait ────────────────────────────────
  // Polar sends the owner back here before `subscription.created` has
  // necessarily landed, so poll the team row rather than showing a live
  // Subscribe button to someone who just paid.
  const returnedFromCheckout = searchParams.get("subscribed") === "true";
  const isTeamActive = team !== null && team.subscriptionStatus !== null;
  const activating = returnedFromCheckout && team !== null && !isTeamActive && !activationTimedOut;

  // The poller reads the latest refresh through a ref so a refresh does not
  // restart the interval, and with it the timeout.
  const refreshRef = useRef(settings.refresh);
  useEffect(() => {
    refreshRef.current = settings.refresh;
  });

  useEffect(() => {
    if (!activating) return;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (hasActivationTimedOut(startedAt, Date.now())) {
        setActivationTimedOut(true);
        return;
      }
      // Shares a read still in flight, so a slow read is not replaced before it lands.
      void refreshRef.current({ reuse: true });
    }, ACTIVATION_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [activating]);

  // Drop the flag once the subscription is live so a later refresh does not
  // re-enter the waiting state.
  useEffect(() => {
    if (!returnedFromCheckout || !isTeamActive) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("subscribed");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [returnedFromCheckout, isTeamActive, router]);

  const poolPercent =
    team && team.requestLimit > 0
      ? Math.min((team.requestsUsed / team.requestLimit) * 100, 100)
      : 0;
  const warned = useRef(false);
  useEffect(() => {
    if (poolPercent > 80 && !warned.current) {
      warned.current = true;
      // Reported as "pro", as the team pool always was, to keep the event comparable.
      trackQuotaWarningShown("pro", poolPercent);
    }
  }, [poolPercent]);

  // ── Actions ──────────────────────────────────────────────────────
  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    setInviteMessage(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/invite`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        trackTeamMemberInvited("success");
        setInviteEmail("");
        const data = (await res.json().catch(() => ({}))) as { warning?: string };
        // The invite exists either way; a warning only means the email did not go out.
        setInviteMessage(
          data.warning
            ? { tone: "warning", text: data.warning }
            : { tone: "success", text: `Invite sent to ${email}.` }
        );
        await loadDetails();
      } else {
        trackTeamMemberInvited("error");
        setInviteMessage({ tone: "error", text: await errorText(res, "The invite was not sent.") });
      }
    } catch {
      setInviteMessage({ tone: "error", text: "The invite was not sent. Check your connection." });
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (invite: TeamInvite) => {
    setCancelingInviteId(invite.id);
    setMembersError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/invites/${invite.id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (res.ok || res.status === 404) {
        // A 404 means it is already gone (accepted, declined or cancelled elsewhere).
        setInvites((previous) => previous.filter((i) => i.id !== invite.id));
        if (res.status === 404) await loadDetails();
      } else {
        setMembersError(`The invite to ${invite.invitedEmail} was not cancelled. Try again.`);
      }
    } catch {
      setMembersError(`The invite to ${invite.invitedEmail} was not cancelled. Try again.`);
    } finally {
      setCancelingInviteId(null);
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    setRemovingId(member.userId);
    setMembersError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/members/${member.userId}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (res.ok) {
        trackTeamMemberRemoved();
        await Promise.all([loadDetails(), settings.refresh()]);
      } else {
        setMembersError(
          await errorText(res, `${member.name ?? member.email} was not removed. Try again.`)
        );
      }
    } catch {
      setMembersError(`${member.name ?? member.email} was not removed. Try again.`);
    } finally {
      setRemovingId(null);
    }
  };

  const handleShare = async (endpointId: string) => {
    setSharing(endpointId);
    setEndpointsError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/endpoints`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ endpointId }),
      });
      if (res.ok) {
        trackEndpointTeamToggled("shared");
        await loadDetails();
      } else {
        setEndpointsError(await errorText(res, "The endpoint was not shared. Try again."));
      }
    } catch {
      setEndpointsError("The endpoint was not shared. Try again.");
    } finally {
      setSharing(null);
    }
  };

  const handleUnshare = async (endpoint: TeamEndpoint) => {
    setSharing(endpoint.id);
    setEndpointsError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/endpoints/${endpoint.id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (res.ok) {
        trackEndpointTeamToggled("unshared");
        await loadDetails();
      } else {
        setEndpointsError(`${endpoint.name ?? endpoint.slug} is still shared. Try again.`);
      }
    } catch {
      setEndpointsError(`${endpoint.name ?? endpoint.slug} is still shared. Try again.`);
    } finally {
      setSharing(null);
    }
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name || !team || name === team.name) return;
    setRenaming(true);
    setRenameMessage(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: "PATCH",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        settings.updateTeam({ ...team, name });
        setRenameMessage({ tone: "success", text: "Team name saved." });
      } else {
        setRenameMessage({ tone: "error", text: await errorText(res, "The name was not saved.") });
      }
    } catch {
      setRenameMessage({ tone: "error", text: "The name was not saved. Check your connection." });
    } finally {
      setRenaming(false);
    }
  };

  const handleDeleteTeam = async () => {
    setDeleting(true);
    setDangerError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, { method: "DELETE", headers: authHeader() });
      if (res.ok) {
        trackTeamDeleted();
        await settings.refresh();
        router.push("/teams");
        return;
      }
      setDangerError(await errorText(res, "The team was not deleted. Try again."));
    } catch {
      setDangerError("The team was not deleted. Check your connection.");
    } finally {
      setDeleting(false);
    }
  };

  const handleLeaveTeam = async () => {
    setLeaving(true);
    setDangerError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/leave`, {
        method: "POST",
        headers: authHeader(),
      });
      if (res.ok) {
        trackTeamLeft();
        await settings.refresh();
        router.push("/teams");
        return;
      }
      setDangerError(await errorText(res, "You are still in this team. Try again."));
    } catch {
      setDangerError("You are still in this team. Check your connection.");
    } finally {
      setLeaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  if (settings.loading || (!team && !teamsSynced)) {
    return <SettingsPageSkeleton label="Loading team" panels={3} />;
  }

  // A stale team from a previous route must never render under a new teamId:
  // every action uses the route's teamId, so the page would act on a different
  // team than it displays.
  if (!team) {
    return (
      <>
        <SettingsPageHeader title="Team not found" />
        <Notice
          tone={settings.loadError ? "danger" : "info"}
          title={
            settings.loadError
              ? "Your teams could not be loaded"
              : "This team was deleted, or you are no longer a member"
          }
          action={
            settings.loadError ? (
              <Button variant="outline" size="sm" onClick={() => void settings.refresh()}>
                Try again
              </Button>
            ) : undefined
          }
        >
          <Link href="/teams" className={settingsLink}>
            Back to your teams
          </Link>
        </Notice>
      </>
    );
  }

  const isOwner = team.role === "owner";
  const subscribed = team.subscriptionStatus !== null;
  const membersById = new Map((members ?? []).map((m) => [m.userId, m]));
  const sharedIds = new Set(endpoints.map((e) => e.id));
  // Until both endpoint lists have loaded, the picker could offer one already shared.
  const shareable = detailError ? [] : ownedEndpoints.filter((ep) => !sharedIds.has(ep.id));
  const seats = seatSlotsFor(team.seats, members ?? [], invites, currentUserId);
  const seatsEndingFrom =
    team.pendingSeats !== null && team.pendingSeats < team.seats ? team.pendingSeats : null;

  const billing = (
    <TeamBillingPanel
      team={team}
      isOwner={isOwner}
      accessToken={accessToken}
      onChanged={settings.refresh}
      activating={activating}
      activationTimedOut={returnedFromCheckout && activationTimedOut}
    />
  );

  return (
    <>
      <SettingsPageHeader title={team.name}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusTag>{isOwner ? "Owner" : "Member"}</StatusTag>
          {team.suspended && !activating && <StatusTag tone="warning">Suspended</StatusTag>}
          <span className="text-sm text-muted-foreground">
            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
          </span>
        </div>
      </SettingsPageHeader>

      <div className="space-y-6">
        {detailError && (
          <Notice
            tone="danger"
            title="Some of this team's details could not be loaded"
            action={
              <Button variant="outline" size="sm" onClick={() => void loadDetails()}>
                Try again
              </Button>
            }
          />
        )}

        {team.suspended && !activating && (
          <Notice tone="warning" title="Team suspended">
            {isOwner
              ? "Without a subscription, members cannot open shared endpoints. Subscribe below to restore access."
              : "This team has no active subscription. Shared endpoints are unavailable until the owner subscribes."}
          </Notice>
        )}

        {subscribed ? (
          <Panel
            id="usage"
            title="Seats and usage"
            description="Each seat adds 100,000 requests to the pool everyone on the team shares."
          >
            <QuotaMeter
              used={team.requestsUsed}
              limit={team.requestLimit}
              seats={seats}
              seatsEndingFrom={seatsEndingFrom}
              caption={team.periodEnd ? `Resets ${longDate(team.periodEnd)}` : undefined}
            />
            {team.blockRequests > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Includes {team.blockRequests.toLocaleString()} from monthly blocks.
              </p>
            )}
          </Panel>
        ) : (
          // Members already see the suspended notice above; only the owner can subscribe.
          isOwner && billing
        )}

        {subscribed && (
          <TeamBusinessPanel
            accessToken={accessToken}
            teamId={team.id}
            business={team.business}
            canManage={isOwner}
            onChanged={() => {
              setBusinessVersion((version) => version + 1);
              void settings.refresh();
            }}
          />
        )}

        {subscribed && team.business && (
          <ParsedPagesPanel
            accessToken={accessToken}
            teamId={team.id}
            canManage={isOwner}
            reloadKey={[
              team.subscriptionStatus,
              team.periodEnd,
              team.business,
              businessVersion,
            ].join(":")}
          />
        )}

        {subscribed && (
          <CapacityPanel
            accessToken={accessToken}
            teamId={team.id}
            canManage={isOwner}
            onChanged={settings.refresh}
            reloadKey={[
              team.subscriptionStatus,
              team.cancelAtPeriodEnd,
              team.periodEnd,
              team.blockRequests,
            ].join(":")}
          />
        )}

        <Panel
          id="members"
          title="Members"
          description="Members open and edit shared endpoints. The owner also manages seats, invites and billing."
          flush
          footer={
            isOwner ? (
              <form
                className="flex w-full flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleInvite();
                }}
              >
                <label htmlFor="invite-email" className="sr-only">
                  Email address to invite
                </label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="name@example.com"
                  value={inviteEmail}
                  onChange={(event) => {
                    setInviteEmail(event.target.value);
                    setInviteMessage(null);
                  }}
                  disabled={inviting}
                  className="max-w-xs bg-background"
                />
                <Button type="submit" disabled={inviting || !inviteEmail.trim()}>
                  {inviting ? "Sending..." : "Invite"}
                </Button>
                {inviteMessage && (
                  <InlineMessage tone={inviteMessage.tone}>{inviteMessage.text}</InlineMessage>
                )}
              </form>
            ) : undefined
          }
        >
          {members === null ? (
            <p className="p-5 text-sm text-muted-foreground">Loading members...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Members and pending invites</caption>
                <thead>
                  <tr className="border-b-strong border-line text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-5 py-2.5 font-medium">
                      Person
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Role
                    </th>
                    <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">
                      Since
                    </th>
                    <th
                      scope="col"
                      className="hidden px-3 py-2.5 text-right font-medium sm:table-cell"
                    >
                      Shared endpoints
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const label = member.name ?? member.email;
                    const isYou = member.userId === currentUserId;
                    const shared = endpoints.filter((e) => e.ownerId === member.userId).length;
                    return (
                      <tr key={member.id} className="border-b border-line/60 last:border-b-0">
                        <td className="px-5 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar name={member.name} email={member.email} image={member.image} />
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {label}
                                {isYou && (
                                  <span className="font-normal text-muted-foreground"> (you)</span>
                                )}
                              </p>
                              {member.name && (
                                <p className="truncate text-xs text-muted-foreground">
                                  {member.email}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {member.role === "owner" ? "Owner" : "Member"}
                        </td>
                        <td className="hidden px-3 py-3 whitespace-nowrap sm:table-cell">
                          {shortDate(member.joinedAt)}
                        </td>
                        <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">
                          {shared}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {isOwner && member.role !== "owner" && !isYou && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  disabled={removingId === member.userId}
                                  aria-label={`Remove ${label}`}
                                >
                                  {removingId === member.userId ? "Removing..." : "Remove"}
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    They lose access to this team&apos;s endpoints, and endpoints
                                    they shared stop being shared. Their seat opens up for someone
                                    else.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep member</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => void handleRemoveMember(member)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Remove
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {invites.map((invite) => (
                    <tr key={invite.id} className="border-b border-line/60 last:border-b-0">
                      <td className="px-5 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="h-8 w-8 shrink-0 rounded-full border border-dashed border-muted-foreground"
                          />
                          <p className="truncate">{invite.invitedEmail}</p>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">Invited</td>
                      <td className="hidden px-3 py-3 whitespace-nowrap text-muted-foreground sm:table-cell">
                        {shortDate(invite.createdAt)}
                      </td>
                      <td className="hidden px-3 py-3 sm:table-cell" />
                      <td className="px-3 py-2 text-right">
                        {isOwner && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCancelInvite(invite)}
                            disabled={cancelingInviteId === invite.id}
                            aria-label={`Cancel the invite to ${invite.invitedEmail}`}
                          >
                            {cancelingInviteId === invite.id ? "Cancelling..." : "Cancel invite"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {membersError && (
            <div className="border-t-strong border-line px-5 py-3">
              <InlineMessage tone="error">{membersError}</InlineMessage>
            </div>
          )}
        </Panel>

        <Panel
          id="shared-endpoints"
          title="Shared endpoints"
          description="Everyone on the team can open these. While the team is active, their requests count against the team's pool instead of the owner's."
          flush
          footer={
            shareable.length > 0 ? (
              <div className="flex w-full flex-wrap items-center gap-3">
                <Select
                  value=""
                  onValueChange={(endpointId) => void handleShare(endpointId)}
                  disabled={sharing !== null || !subscribed}
                >
                  <SelectTrigger
                    className="max-w-xs bg-background"
                    aria-label="Share one of your endpoints"
                  >
                    <SelectValue placeholder="Share one of your endpoints" />
                  </SelectTrigger>
                  <SelectContent>
                    {shareable.map((ep) => (
                      <SelectItem key={ep.id} value={ep.id}>
                        {ep.name || ep.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!subscribed && (
                  <p className="text-sm text-muted-foreground">
                    Sharing opens once the team has a subscription.
                  </p>
                )}
              </div>
            ) : undefined
          }
        >
          {endpoints.length === 0 && detailError ? (
            <p className="p-5 text-sm text-muted-foreground">
              The shared endpoints could not be loaded. Try again above.
            </p>
          ) : endpoints.length === 0 ? (
            <div className="space-y-1 p-5">
              <p className="text-sm font-medium">Nothing shared yet</p>
              <p className="text-sm text-muted-foreground">
                {ownedEndpoints.length > 0
                  ? "Share one of your endpoints below to give the team access."
                  : "Create an endpoint on the dashboard, then share it here."}
              </p>
            </div>
          ) : (
            <ul>
              {endpoints.map((endpoint) => {
                const owner = membersById.get(endpoint.ownerId);
                const mine = endpoint.ownerId === currentUserId;
                return (
                  <li
                    key={endpoint.id}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-medium">
                        {endpoint.name ?? endpoint.slug}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {endpoint.slug}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {endpoint.requestCount.toLocaleString()} requests
                      </span>
                      <span className="flex items-center gap-2 text-sm whitespace-nowrap">
                        <Avatar
                          name={endpoint.ownerName}
                          email={endpoint.ownerEmail}
                          image={owner?.image ?? null}
                          size="sm"
                        />
                        {mine ? "You" : (endpoint.ownerName ?? endpoint.ownerEmail)}
                      </span>
                      <span className="flex w-24 justify-end">
                        {mine && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleUnshare(endpoint)}
                            disabled={sharing === endpoint.id}
                            aria-label={`Stop sharing ${endpoint.name ?? endpoint.slug}`}
                          >
                            {sharing === endpoint.id ? "Unsharing..." : "Unshare"}
                          </Button>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {endpointsError && (
            <div className="border-t-strong border-line px-5 py-3">
              <InlineMessage tone="error">{endpointsError}</InlineMessage>
            </div>
          )}
        </Panel>

        {subscribed && billing}

        {isOwner && (
          <Panel
            id="team-name"
            title="Team name"
            description="Members see this name in their side nav and in invites."
            footer={
              <>
                <Button
                  onClick={() => void handleRename()}
                  disabled={renaming || !renameValue.trim() || renameValue.trim() === team.name}
                >
                  {renaming ? "Saving..." : "Save name"}
                </Button>
                {renameMessage && (
                  <InlineMessage tone={renameMessage.tone}>{renameMessage.text}</InlineMessage>
                )}
              </>
            }
          >
            <Input
              id="team-name-input"
              aria-labelledby="team-name-title"
              value={renameValue}
              onChange={(event) => {
                setRenameValue(event.target.value);
                setRenameMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRename();
              }}
              disabled={renaming}
              className="max-w-sm"
            />
          </Panel>
        )}

        {isOwner ? (
          <Panel
            id="delete-team"
            tone="danger"
            title="Delete team"
            description="Removes every member and stops sharing every endpoint. Endpoints stay with their owners. This cannot be undone."
            footer={
              <>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={deleting}>
                      {deleting ? "Deleting..." : "Delete team"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {team.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Every member loses access to the team&apos;s endpoints. This cannot be
                        undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep team</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void handleDeleteTeam()}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete team
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                {dangerError && <InlineMessage tone="error">{dangerError}</InlineMessage>}
              </>
            }
          />
        ) : (
          <Panel
            id="leave-team"
            tone="danger"
            title="Leave team"
            description="You lose access to the team's endpoints, and endpoints you shared stop being shared."
            footer={
              <>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={leaving}>
                      {leaving ? "Leaving..." : "Leave team"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Leave {team.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        To come back, the owner has to invite you again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Stay</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void handleLeaveTeam()}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Leave team
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                {dangerError && <InlineMessage tone="error">{dangerError}</InlineMessage>}
              </>
            }
          />
        )}
      </div>
    </>
  );
}

export default function TeamDetailPage() {
  // useSearchParams (the post-checkout `?subscribed=true` flag) needs a Suspense
  // boundary above it.
  return (
    <Suspense fallback={<SettingsPageSkeleton label="Loading team" panels={3} />}>
      <TeamDetailContent />
    </Suspense>
  );
}
