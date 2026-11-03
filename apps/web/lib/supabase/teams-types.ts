import type { EndpointSite } from "@/lib/site";
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
  /** The pool's allowance this period: seats x the plan's per-seat requests, plus monthly blocks. */
  requestLimit: number;
  /** Requests monthly blocks add to requestLimit this period (migration 00065). */
  blockRequests: number;
  /**
   * The team is on Team Business: Business's limits per seat and its features
   * for shared endpoints (the team plan's own product since migration 00082).
   */
  business: boolean;
  /** The subscription's interval: annual billing is only for Team Business; null when unsubscribed. */
  billingInterval: "month" | "year" | null;
  /** A plan change waiting for the renewal (a downgrade), or null. */
  pendingPlan: "team" | "team_business" | null;
  pendingInterval: "month" | "year" | null;
  /** End of the current quota period in millis (a month, also on annual billing); null when unsubscribed. */
  periodEnd: number | null;
  /** When the subscription renews, in millis: the year's end on annual billing; null when unsubscribed. */
  billingPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** Seat count a scheduled reduction applies at the next renewal; null when none. */
  pendingSeats: number | null;
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
  /** Oldest share among the caller's subscribed teams. */
  fromTeam: { teamId: string; teamName: string };
  /** Every subscribed team of the caller this endpoint is shared with. */
  fromTeams: { teamId: string; teamName: string }[];
  ownerId: string;
  /** The endpoint's capture address; shared endpoints always have an owner. */
  emailAddress: string | null;
  showEmailExtracts: boolean;
  /** Which site's dashboard lists it, as its owner chose (lib/site.ts). */
  site: EndpointSite;
  /** Forwarding state without the URL (owner-only): enough to show delivery history. */
  forwardEnabled: boolean;
  hasForwardSecret: boolean;
}

/** One endpoint shared with a team, as the team page lists it. */
export interface TeamSharedEndpoint {
  id: string;
  slug: string;
  name: string | null;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  /** User id of the member who shared it. */
  sharedBy: string;
  /** Share time in millis. */
  sharedAt: number;
  requestCount: number;
}
