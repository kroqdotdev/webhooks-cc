"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, HelpCircle, Trash2, UserPlus } from "lucide-react";
import Link from "next/link";

interface Member {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: "owner" | "member";
}

interface PendingInvite {
  id: string;
  email: string;
  createdAt: string;
}

function MemberAvatar({ member }: { member: Member }) {
  if (member.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.image}
        alt=""
        className="h-8 w-8 rounded-full border-2 border-foreground"
      />
    );
  }
  const initial = (member.name?.[0] ?? member.email[0] ?? "?").toUpperCase();
  return (
    <div className="h-8 w-8 rounded-full border-2 border-foreground bg-muted flex items-center justify-center text-xs font-bold">
      {initial}
    </div>
  );
}

function HelpTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Help"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 top-6 z-50 w-64 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md">
          {text}
        </div>
      )}
    </div>
  );
}

export default function TeamDetailPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = params.teamId as string;
  const { session, isLoading: authLoading } = useAuth();

  const [teamName, setTeamName] = useState("");
  const [role, setRole] = useState<"owner" | "member">("member");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Rename
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameMessage, setRenameMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Remove member
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Shared endpoints
  const [ownedEndpoints, setOwnedEndpoints] = useState<
    Array<{ id: string; slug: string; name?: string; sharedWith?: Array<{ teamId: string }> }>
  >([]);
  const [togglingEndpoint, setTogglingEndpoint] = useState<string | null>(null);

  // Delete team
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const authHeader: Record<string, string> = session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};

  const fetchData = async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const [teamsRes, membersRes, endpointsRes] = await Promise.all([
        fetch("/api/teams", { headers: authHeader }),
        fetch(`/api/teams/${teamId}/members`, { headers: authHeader }),
        fetch("/api/endpoints", { headers: authHeader }),
      ]);

      if (teamsRes.ok) {
        const teams: Array<{
          id: string;
          name: string;
          role: "owner" | "member";
        }> = await teamsRes.json();
        const team = teams.find((t) => t.id === teamId);
        if (team) {
          setTeamName(team.name);
          setRenameValue(team.name);
          setRole(team.role);
        }
      }

      if (membersRes.ok) {
        const data: { members: Member[]; pendingInvites: PendingInvite[] } =
          await membersRes.json();
        setMembers(data.members ?? []);
        setPendingInvites(data.pendingInvites ?? []);
      }

      if (endpointsRes.ok) {
        const data = (await endpointsRes.json()) as {
          owned: Array<{ id: string; slug: string; name?: string; sharedWith?: Array<{ teamId: string }> }>;
        };
        setOwnedEndpoints(data.owned ?? []);
      }

      // Identify current user from session
      setCurrentUserId(session.user?.id ?? null);
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
  }, [authLoading, session, teamId]);

  const handleRemoveMember = async (userId: string) => {
    setRemovingId(userId);
    try {
      const res = await fetch(`/api/teams/${teamId}/members/${userId}`, {
        method: "DELETE",
        headers: authHeader,
      });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.id !== userId));
      }
    } finally {
      setRemovingId(null);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteMessage(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/invite`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      if (res.ok) {
        setInviteEmail("");
        setInviteMessage({ type: "success", text: "Invite sent successfully." });
        await fetchData();
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setInviteMessage({
          type: "error",
          text: data.error ?? "Failed to send invite.",
        });
      }
    } finally {
      setInviting(false);
    }
  };

  const handleRename = async () => {
    if (!renameValue.trim() || renameValue.trim() === teamName) return;
    setRenaming(true);
    setRenameMessage(null);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: "PATCH",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      if (res.ok) {
        setTeamName(renameValue.trim());
        setRenameMessage({ type: "success", text: "Team name updated." });
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setRenameMessage({
          type: "error",
          text: data.error ?? "Failed to update team name.",
        });
      }
    } finally {
      setRenaming(false);
    }
  };

  const handleToggleEndpoint = async (endpointId: string, isShared: boolean) => {
    setTogglingEndpoint(endpointId);
    try {
      if (isShared) {
        await fetch(`/api/teams/${teamId}/endpoints/${endpointId}`, {
          method: "DELETE",
          headers: authHeader,
        });
      } else {
        await fetch(`/api/teams/${teamId}/endpoints`, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ endpointId }),
        });
      }
      // Refresh endpoint data
      const res = await fetch("/api/endpoints", { headers: authHeader });
      if (res.ok) {
        const data = (await res.json()) as {
          owned: Array<{ id: string; slug: string; name?: string; sharedWith?: Array<{ teamId: string }> }>;
        };
        setOwnedEndpoints(data.owned ?? []);
      }
    } finally {
      setTogglingEndpoint(null);
    }
  };

  const handleDeleteTeam = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/teams/${teamId}`, {
        method: "DELETE",
        headers: authHeader,
      });
      if (res.ok) {
        router.push("/teams");
      }
    } finally {
      setDeleting(false);
    }
  };

  if (authLoading || loading) {
    return (
      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </main>
    );
  }

  const isOwner = role === "owner";

  return (
    <main className="container mx-auto px-4 py-8 max-w-2xl space-y-8">
      {/* Back link + heading */}
      <div className="space-y-2">
        <Link
          href="/teams"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Teams
        </Link>
        <h1 className="text-2xl font-bold">{teamName}</h1>
      </div>

      {/* Members */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Members</h2>
          <HelpTooltip text="Owner can manage the team, invite and remove members, and delete it. Members can view and edit shared endpoints." />
        </div>
        <div className="border rounded-lg p-6 bg-card">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-4">
              {members.map((member, i) => (
                <div key={member.id}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <MemberAvatar member={member} />
                      <div className="min-w-0">
                        {member.name && (
                          <p className="font-medium truncate">{member.name}</p>
                        )}
                        <p className="text-sm text-muted-foreground truncate">
                          {member.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                        {member.role}
                      </Badge>
                      {isOwner && member.role !== "owner" && member.id !== currentUserId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => void handleRemoveMember(member.id)}
                          disabled={removingId === member.id}
                          aria-label={`Remove ${member.name ?? member.email}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {i < members.length - 1 && <div className="border-t mt-4" />}
                </div>
              ))}
            </div>
          )}

          {/* Pending Invites */}
          {pendingInvites.length > 0 && (
            <>
              <div className="border-t mt-4 pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Pending Invites</p>
                <div className="space-y-3">
                  {pendingInvites.map((invite) => (
                    <div
                      key={invite.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <p className="text-sm">{invite.email}</p>
                      <Badge variant="outline">pending</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Invite Member (owner only) */}
      {isOwner && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Invite Member</h2>
            <HelpTooltip text="Enter the email of a registered webhooks.cc user. They'll receive an invite they can accept or decline." />
          </div>
          <div className="border rounded-lg p-6 space-y-4 bg-card">
            <Label htmlFor="invite-email">Email address</Label>
            <div className="flex gap-2">
              <Input
                id="invite-email"
                type="email"
                placeholder="user@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInvite();
                }}
                disabled={inviting}
              />
              <Button
                onClick={() => void handleInvite()}
                disabled={inviting || !inviteEmail.trim()}
              >
                <UserPlus className="h-4 w-4 mr-1" />
                {inviting ? "Sending..." : "Invite"}
              </Button>
            </div>
            {inviteMessage && (
              <p
                className={`text-sm ${
                  inviteMessage.type === "success"
                    ? "text-green-600"
                    : "text-destructive"
                }`}
              >
                {inviteMessage.text}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Shared Endpoints (owner only) */}
      {isOwner && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Shared Endpoints</h2>
            <HelpTooltip text="Endpoints shared with this team. All members can view requests and edit settings. Only the endpoint owner can delete or manage sharing." />
          </div>
          <div className="border rounded-lg p-6 bg-card space-y-4">
            {(() => {
              const shared = ownedEndpoints.filter(
                (ep) => ep.sharedWith?.some((s) => s.teamId === teamId)
              );
              const unshared = ownedEndpoints.filter(
                (ep) => !ep.sharedWith?.some((s) => s.teamId === teamId)
              );
              return (
                <>
                  {shared.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No endpoints shared with this team yet.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {shared.map((ep) => (
                        <div key={ep.id} className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{ep.name || ep.slug}</p>
                            {ep.name && (
                              <p className="text-xs text-muted-foreground font-mono truncate">{ep.slug}</p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                            onClick={() => void handleToggleEndpoint(ep.id, true)}
                            disabled={togglingEndpoint === ep.id}
                          >
                            {togglingEndpoint === ep.id ? "..." : "Remove"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {unshared.length > 0 && (
                    <div className={shared.length > 0 ? "pt-4 border-t" : ""}>
                      <Select
                        value=""
                        onValueChange={(endpointId) => {
                          void handleToggleEndpoint(endpointId, false);
                        }}
                        disabled={togglingEndpoint !== null}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Add an endpoint..." />
                        </SelectTrigger>
                        <SelectContent>
                          {unshared.map((ep) => (
                            <SelectItem key={ep.id} value={ep.id}>
                              {ep.name || ep.slug}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </section>
      )}

      {/* Team Settings (owner only) */}
      {isOwner && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Team Settings</h2>
          <div className="border rounded-lg p-6 space-y-4 bg-card">
            <Label htmlFor="team-name">Team name</Label>
            <div className="flex gap-2">
              <Input
                id="team-name"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRename();
                }}
                disabled={renaming}
              />
              <Button
                onClick={() => void handleRename()}
                disabled={
                  renaming ||
                  !renameValue.trim() ||
                  renameValue.trim() === teamName
                }
              >
                {renaming ? "Saving..." : "Save"}
              </Button>
            </div>
            {renameMessage && (
              <p
                className={`text-sm ${
                  renameMessage.type === "success"
                    ? "text-green-600"
                    : "text-destructive"
                }`}
              >
                {renameMessage.text}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Danger Zone (owner only) */}
      {isOwner && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
          <div className="border rounded-lg p-6 bg-card space-y-2">
            <p className="text-sm text-muted-foreground">
              Permanently delete this team and remove all members. This cannot be undone.
            </p>
            <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
              <DialogTrigger asChild>
                <Button variant="destructive">Delete Team</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete team</DialogTitle>
                  <DialogDescription>
                    Are you sure you want to delete <strong>{teamName}</strong>?
                    This will remove all members and cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDeleteOpen(false)}
                    disabled={deleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void handleDeleteTeam()}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting..." : "Delete Team"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </section>
      )}
    </main>
  );
}
