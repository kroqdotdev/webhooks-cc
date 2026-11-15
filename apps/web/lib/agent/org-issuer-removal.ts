/**
 * What removing a team's organisation issuer disconnected, as the team page
 * tells the owner (DELETE /api/teams/[teamId]/idjag-issuers/[issuerId]).
 */

export interface DisconnectedAgent {
  id: string;
  client_name: string | null;
  pending: boolean;
  member_email: string | null;
}

function agentsText(count: number): string {
  return count === 1 ? "one agent" : `${count} agents`;
}

/** The owner's message: how many, and each client with its member. */
export function removedText(revoked: number, disconnected: DisconnectedAgent[]): string {
  if (revoked === 0) return "Issuer removed. No agent was connected through it.";
  const named = disconnected
    .map((agent) => {
      const client = agent.client_name ?? "An agent";
      const member = agent.member_email ? ` for ${agent.member_email}` : "";
      return `${client}${member}${agent.pending ? " (not yet confirmed)" : ""}`;
    })
    .join("; ");
  const head = `Issuer removed. Disconnected ${agentsText(revoked)}`;
  return named ? `${head}: ${named}.` : `${head}.`;
}

/** The removal dialog's warning, from the count the list gives the owner. */
export function removalWarning(connected: number | undefined): string {
  if (connected === undefined) {
    return "Every agent it connected is disconnected now, and their tokens stop working.";
  }
  if (connected === 0) return "No agent is connected through it now.";
  const subject = connected === 1 ? "One agent is" : `${connected} agents are`;
  const them =
    connected === 1
      ? "It is disconnected now and its tokens stop"
      : "They are all disconnected now and their tokens stop";
  return `${subject} connected through it. ${them} working, members of another team that trusts the same issuer included; they connect again there.`;
}
