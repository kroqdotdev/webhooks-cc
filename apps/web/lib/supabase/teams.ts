// Barrel re-exports — split modules by responsibility.
// All existing imports from "@/lib/supabase/teams" continue to work.

// Types
export type {
  Team,
  TeamMember,
  TeamInvite,
  TeamEndpointShare,
  SharedEndpoint,
  TeamSharedEndpoint,
} from "./teams-types";

// Team CRUD
export { createTeam, listTeamsForUser, updateTeam, deleteTeam } from "./teams-crud";

// Subscription gating
export {
  requireActiveTeam,
  hasActiveTeamMembership,
  hasAnyTeamMembership,
  TEAM_INACTIVE_MESSAGE,
} from "./teams-gating";

// Membership
export { listTeamMembers, removeTeamMember, leaveTeam } from "./teams-members";

// Invites
export {
  createInvite,
  listPendingInvitesForUser,
  listPendingInvitesForTeam,
  acceptInvite,
  declineInvite,
  revokeInvite,
} from "./teams-invites";

// Endpoint sharing
export {
  shareEndpointWithTeam,
  unshareEndpointFromTeam,
  getTeamSharesForEndpoint,
  getSharedEndpointsForUser,
  resolveEndpointAccess,
  getShareMetadataForOwnedEndpoints,
  listTeamEndpoints,
} from "./teams-endpoints";
