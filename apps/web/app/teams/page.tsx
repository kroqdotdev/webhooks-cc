"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Lock } from "lucide-react";
import Link from "next/link";

interface Team {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  role: "owner" | "member";
  suspended: boolean;
}

interface Invite {
  id: string;
  teamId: string;
  teamName: string;
  inviterEmail: string;
  createdAt: number;
}

export default function TeamsPage() {
  const { user: authUser, session, isLoading: authLoading } = useAuth();
  const [plan, setPlan] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);

  const authHeader: Record<string, string> = session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};

  const fetchData = async () => {
    if (!session?.access_token || !authUser) return;
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = createClient();
      const [planRes, teamsRes, invitesRes] = await Promise.all([
        supabase.from("users").select("plan").eq("id", authUser.id).single<{ plan: string }>(),
        fetch("/api/teams", { headers: authHeader }),
        fetch("/api/invites", { headers: authHeader }),
      ]);

      if (planRes.error) {
        setLoadError("Failed to load account data. Please try refreshing.");
        return;
      }
      setPlan(planRes.data.plan);

      if (!teamsRes.ok || !invitesRes.ok) {
        setLoadError("Failed to load teams. Please try refreshing.");
        return;
      }

      setTeams((await teamsRes.json()) as Team[]);
      setInvites((await invitesRes.json()) as Invite[]);
    } catch {
      setLoadError("Failed to load teams. Please try refreshing.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && session) {
      void fetchData();
    } else if (!authLoading && !session) {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, session]);

  const handleCreateTeam = async () => {
    if (!newTeamName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTeamName.trim() }),
      });
      if (res.ok) {
        setNewTeamName("");
        setCreateOpen(false);
        await fetchData();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setCreateError(data.error ?? "Failed to create team.");
      }
    } finally {
      setCreating(false);
    }
  };

  const handleAccept = async (inviteId: string) => {
    setAcceptingId(inviteId);
    try {
      const res = await fetch(`/api/invites/${inviteId}/accept`, {
        method: "POST",
        headers: authHeader,
      });
      if (res.ok) {
        await fetchData();
      }
    } finally {
      setAcceptingId(null);
    }
  };

  const handleDecline = async (inviteId: string) => {
    setDecliningId(inviteId);
    try {
      const res = await fetch(`/api/invites/${inviteId}/decline`, {
        method: "POST",
        headers: authHeader,
      });
      if (res.ok) {
        setInvites((prev) => prev.filter((i) => i.id !== inviteId));
      }
    } finally {
      setDecliningId(null);
    }
  };

  if (authLoading || loading) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Teams</h1>
          <div className="border rounded-lg p-6 bg-card space-y-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>
              Retry
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const isPro = plan === "pro";
  const ownedTeams = teams.filter((t) => t.role === "owner");
  const memberTeams = teams.filter((t) => t.role === "member");

  // Free user with no team memberships at all → full upgrade wall
  if (!isPro && teams.length === 0 && invites.length === 0) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <section className="space-y-4">
          <h1 className="text-2xl font-bold">Teams</h1>
          <div className="border rounded-lg p-6 bg-card space-y-4">
            <div className="flex items-center gap-3">
              <Lock className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="font-medium">Teams is a Pro feature</p>
                <p className="text-sm text-muted-foreground">
                  Collaborate on webhook endpoints with your team. Create teams, invite members, and
                  share endpoints — all in real time.
                </p>
              </div>
            </div>
            <Button asChild>
              <Link href="/account">Upgrade to Pro</Link>
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8 max-w-2xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Teams</h1>
        {isPro ? (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                New Team
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a new team</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label htmlFor="team-name">Team name</Label>
                <Input
                  id="team-name"
                  placeholder="e.g. Acme Corp"
                  value={newTeamName}
                  onChange={(e) => {
                    setNewTeamName(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateTeam();
                  }}
                  autoFocus
                />
                {createError && <p className="text-sm text-destructive">{createError}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleCreateTeam()}
                  disabled={creating || !newTeamName.trim()}
                >
                  {creating ? "Creating..." : "Create team"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <Button size="sm" variant="outline" asChild>
            <Link href="/account">Upgrade to Pro</Link>
          </Button>
        )}
      </div>

      {/* Free user who owns teams — show suspension notice */}
      {!isPro && ownedTeams.length > 0 && (
        <div className="rounded-md border border-yellow-500/20 bg-yellow-500/10 p-4 space-y-2">
          <p className="font-medium text-yellow-700 dark:text-yellow-400">
            Your teams are suspended
          </p>
          <p className="text-sm text-muted-foreground">
            Your plan is no longer Pro. Shared endpoints are inaccessible to team members.{" "}
            <Link href="/account" className="underline font-medium text-foreground">
              Upgrade to Pro
            </Link>{" "}
            to reactivate.
          </p>
        </div>
      )}

      {/* Pending Invites */}
      {invites.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Pending Invites</h2>
          <div className="border rounded-lg p-6 space-y-4 bg-card">
            {invites.map((invite, i) => (
              <div key={invite.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{invite.teamName}</p>
                    <p className="text-sm text-muted-foreground">
                      Invited by {invite.inviterEmail}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isPro ? (
                      <Button
                        size="sm"
                        onClick={() => void handleAccept(invite.id)}
                        disabled={acceptingId === invite.id || decliningId === invite.id}
                      >
                        {acceptingId === invite.id ? "Accepting..." : "Accept"}
                      </Button>
                    ) : (
                      <Button size="sm" asChild>
                        <Link href="/account">Upgrade to accept</Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleDecline(invite.id)}
                      disabled={acceptingId === invite.id || decliningId === invite.id}
                    >
                      {decliningId === invite.id ? "Declining..." : "Decline"}
                    </Button>
                  </div>
                </div>
                {i < invites.length - 1 && <div className="border-t mt-4" />}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* My Teams — only show if user owns teams */}
      {ownedTeams.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">My Teams</h2>
          <div className="border rounded-lg p-6 bg-card">
            {
              <div className="space-y-4">
                {ownedTeams.some((t) => t.suspended) && (
                  <div className="rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm">
                    <p className="font-medium text-yellow-700 dark:text-yellow-400">
                      Your teams are suspended
                    </p>
                    <p className="text-muted-foreground">
                      Your plan has been downgraded. Shared endpoints are inaccessible to team
                      members until you{" "}
                      <Link href="/account" className="underline font-medium text-foreground">
                        upgrade to Pro
                      </Link>
                      .
                    </p>
                  </div>
                )}
                {ownedTeams.map((team, i) => (
                  <div key={team.id}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium">{team.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
                          </p>
                        </div>
                        {team.suspended && (
                          <Badge variant="outline" className="text-yellow-600 border-yellow-500/50">
                            Suspended
                          </Badge>
                        )}
                      </div>
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/teams/${team.id}`}>Manage</Link>
                      </Button>
                    </div>
                    {i < ownedTeams.length - 1 && <div className="border-t mt-4" />}
                  </div>
                ))}
              </div>
            }
          </div>
        </section>
      )}

      {/* Teams I'm In — only show if user is a member of teams */}
      {memberTeams.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Teams I&apos;m In</h2>
          <div className="border rounded-lg p-6 bg-card">
            {
              <div className="space-y-4">
                {memberTeams.map((team, i) => (
                  <div key={team.id}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium">{team.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
                          </p>
                        </div>
                        {team.suspended ? (
                          <Badge variant="outline" className="text-yellow-600 border-yellow-500/50">
                            Suspended
                          </Badge>
                        ) : !isPro ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            Pro required
                          </Badge>
                        ) : null}
                      </div>
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/teams/${team.id}`}>View</Link>
                      </Button>
                    </div>
                    {team.suspended ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        The team owner has downgraded their plan. Shared endpoints are inaccessible
                        until they upgrade.
                      </p>
                    ) : !isPro ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        <Link href="/account" className="underline">
                          Upgrade to Pro
                        </Link>{" "}
                        to access shared endpoints from this team.
                      </p>
                    ) : null}
                    {i < memberTeams.length - 1 && <div className="border-t mt-4" />}
                  </div>
                ))}
              </div>
            }
          </div>
        </section>
      )}
    </main>
  );
}
