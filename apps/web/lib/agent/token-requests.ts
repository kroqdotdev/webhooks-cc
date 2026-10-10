/**
 * Requests whose bearer was an agent access token, as found by the bearer
 * check, so the audit trail can record `via: agent_token` without looking
 * the key up again. Held weakly: entries go with their request.
 */
const agentTokenRequests = new WeakSet<Request>();

export function markAgentTokenRequest(request: Request): void {
  agentTokenRequests.add(request);
}

export function isAgentTokenRequest(request: Request): boolean {
  return agentTokenRequests.has(request);
}
