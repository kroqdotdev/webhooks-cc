import type { Database } from "./database";

// ---------------------------------------------------------------------------
// DB row type aliases
// ---------------------------------------------------------------------------

export type TeamRow = Database["public"]["Tables"]["teams"]["Row"];
export type TeamMemberRow = Database["public"]["Tables"]["team_members"]["Row"];
export type TeamInviteRow = Database["public"]["Tables"]["team_invites"]["Row"];
export type TeamEndpointRow = Database["public"]["Tables"]["team_endpoints"]["Row"];

// ---------------------------------------------------------------------------
// Application-level types
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  role: "owner" | "member";
  /** True while the team has no subscription — `subscriptionStatus === null`. */
  suspended: boolean;
  subscriptionStatus: "active" | "canceled" | "past_due" | null;
  seats: number;
  requestsUsed: number;
  requestLimit: number;
  /** End of the current billing period in millis; null when unsubscribed. */
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: "owner" | "member";
  joinedAt: number;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  teamName: string;
  invitedBy: string;
  inviterEmail: string;
  invitedEmail: string;
  status: "pending" | "accepted" | "declined";
  createdAt: number;
}

export interface TeamEndpointShare {
  teamId: string;
  teamName: string;
}

export interface SharedEndpoint {
  id: string;
  slug: string;
  name: string | null;
  url: string | undefined;
  mockResponse: {
    status: number;
    body: string;
    headers: Record<string, string>;
    delay?: number;
  } | null;
  isEphemeral: boolean;
  createdAt: number;
  fromTeam: { teamId: string; teamName: string };
  ownerId: string;
}
