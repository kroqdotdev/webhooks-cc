import { resolveMx, resolveTxt } from "node:dns/promises";
import { createAdminClient } from "./admin";
import { getTeamForOwner } from "./team-billing";
import { reportError } from "@/lib/observability";
import { mailhooksOrigin, webhooksOrigin } from "@/lib/site";

/**
 * Custom inbound domains (migration 00072): an account on Business, or a team
 * with Team Business, receives mail at its own domain. It proves the domain
 * with a TXT record and points the domain's MX at the MX host; the receiver
 * then routes local@domain to an endpoint (resolve_inbound_recipient). This
 * module adds, verifies, routes and re-checks them; DNS is looked up here,
 * never by the receiver or the MX host.
 */

export type DomainAccount = { kind: "user"; userId: string } | { kind: "team"; teamId: string };

export interface DomainRoute {
  localPart: string;
  endpointId: string;
}

export interface InboundDomain {
  id: string;
  domain: string;
  status: "pending" | "verified" | "lapsed";
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failedChecks: number;
  catchAllEndpointId: string | null;
  routes: DomainRoute[];
  /** The DNS records to add. */
  records: { txt: { name: string; value: string }; mx: { name: string; value: string } };
  /** Receives mail now: verified and within what the plan allows. */
  active: boolean;
}

export class DomainError extends Error {
  constructor(
    public code:
      | "invalid"
      | "not_allowed"
      | "plan_required"
      | "too_many"
      | "exists"
      | "held"
      | "not_found"
      | "bad_route",
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Domains an owner may add at most (pending ones included). */
export const MAX_DOMAINS_PER_ACCOUNT = 20;
/** Routes (local parts) per domain. */
export const MAX_ROUTES_PER_DOMAIN = 100;
/** Failed checks in a row after which a verified domain lapses. */
export const LAPSE_AFTER_FAILED_CHECKS = 3;
/** How often a verified domain's records are looked up again. */
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

/** The host the domain's MX must point at. */
export function mxHost(): string {
  return (process.env.MAIL_MX_HOST || "mx.mailhooks.cc").toLowerCase().replace(/\.$/, "");
}

export function txtName(domain: string): string {
  return `_mailhooks.${domain}`;
}

export function txtValue(token: string): string {
  return `mailhooks-verify=${token}`;
}

/** A domain as typed (any case, trailing dot), or null when it is not one. */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  return domain.length <= 253 && DOMAIN.test(domain) ? domain : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Domains that can never be a customer's: the capture domain, this app's
 * hosts and the receiver's, and anything under them.
 */
export function isReservedDomain(domain: string): boolean {
  const reserved = [
    process.env.EMAIL_CAPTURE_DOMAIN || "mailhooks.cc",
    "mailhooks.cc",
    "webhooks.cc",
    hostOf(webhooksOrigin()),
    hostOf(mailhooksOrigin()),
    hostOf(process.env.NEXT_PUBLIC_WEBHOOK_URL ?? null),
  ].filter((host): host is string => !!host && host.includes("."));
  return reserved.some((host) => domain === host || domain.endsWith(`.${host}`));
}

/** DNS lookups, swappable in tests. Missing records come back empty. */
export interface DomainResolver {
  txt(name: string): Promise<string[]>;
  mx(domain: string): Promise<string[]>;
}

function emptyOnMissing(error: unknown): never[] {
  const code = (error as { code?: string }).code;
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "ESERVFAIL" || code === "NXDOMAIN") {
    return [];
  }
  throw error;
}

export const systemResolver: DomainResolver = {
  async txt(name) {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (error) {
      return emptyOnMissing(error);
    }
  },
  async mx(domain) {
    try {
      return (await resolveMx(domain)).map((record) =>
        record.exchange.toLowerCase().replace(/\.$/, "")
      );
    } catch (error) {
      return emptyOnMissing(error);
    }
  },
};

/** Which of the two records are in place. */
export async function checkRecords(
  domain: string,
  token: string,
  resolver: DomainResolver = systemResolver
): Promise<{ txt: boolean; mx: boolean }> {
  const [txt, mx] = await Promise.all([resolver.txt(txtName(domain)), resolver.mx(domain)]);
  return {
    txt: txt.some((value) => value.trim() === txtValue(token)),
    mx: mx.includes(mxHost()),
  };
}

interface DomainRow {
  id: string;
  user_id: string | null;
  team_id: string | null;
  domain: string;
  token: string;
  status: "pending" | "verified" | "lapsed";
  verified_at: string | null;
  last_checked_at: string | null;
  failed_checks: number;
  catch_all_endpoint_id: string | null;
}

const DOMAIN_COLUMNS =
  "id, user_id, team_id, domain, token, status, verified_at, last_checked_at, failed_checks, catch_all_endpoint_id";

function ownerFilter(account: DomainAccount) {
  return account.kind === "user"
    ? { column: "user_id", value: account.userId }
    : { column: "team_id", value: account.teamId };
}

/** Throws unless `actingUserId` may manage the account's domains (a team: its owner). */
export async function assertCanManageDomains(
  account: DomainAccount,
  actingUserId: string
): Promise<void> {
  if (account.kind === "team") {
    await getTeamForOwner(actingUserId, account.teamId);
  } else if (account.userId !== actingUserId) {
    throw new DomainError("not_found", "Domain not found", 404);
  }
}

async function allowance(account: DomainAccount): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("inbound_domains_allowed", {
    p_user_id: account.kind === "user" ? account.userId : null,
    p_team_id: account.kind === "team" ? account.teamId : null,
  });
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

export async function listDomains(account: DomainAccount): Promise<InboundDomain[]> {
  const admin = createAdminClient();
  const owner = ownerFilter(account);
  const { data, error } = await admin
    .from("inbound_domains")
    .select(DOMAIN_COLUMNS)
    .eq(owner.column, owner.value)
    .order("created_at");
  if (error) throw error;
  const rows = (data ?? []) as unknown as DomainRow[];
  const ids = rows.map((row) => row.id);
  const { data: routeRows, error: routesError } = ids.length
    ? await admin
        .from("inbound_domain_routes")
        .select("domain_id, local_part, endpoint_id")
        .in("domain_id", ids)
        .order("local_part")
    : { data: [], error: null };
  if (routesError) throw routesError;
  const routes = new Map<string, DomainRoute[]>();
  for (const route of (routeRows ?? []) as unknown as {
    domain_id: string;
    local_part: string;
    endpoint_id: string;
  }[]) {
    const list = routes.get(route.domain_id) ?? [];
    list.push({ localPart: route.local_part, endpointId: route.endpoint_id });
    routes.set(route.domain_id, list);
  }
  const allowed = await allowance(account);
  // The verified ones count against the plan in the order they were verified.
  const activeIds = new Set(
    rows
      .filter((row) => row.status === "verified")
      .sort(
        (a, b) =>
          (a.verified_at ?? "").localeCompare(b.verified_at ?? "") || a.id.localeCompare(b.id)
      )
      .slice(0, Math.max(allowed, 0))
      .map((row) => row.id)
  );
  return rows.map((row) => ({
    id: row.id,
    domain: row.domain,
    status: row.status,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    failedChecks: row.failed_checks,
    catchAllEndpointId: row.catch_all_endpoint_id,
    routes: routes.get(row.id) ?? [],
    records: {
      txt: { name: txtName(row.domain), value: txtValue(row.token) },
      mx: { name: row.domain, value: mxHost() },
    },
    active: activeIds.has(row.id),
  }));
}

export async function addDomain(account: DomainAccount, raw: string): Promise<InboundDomain> {
  const domain = normalizeDomain(raw);
  if (!domain) throw new DomainError("invalid", "Enter a domain name, such as inbound.acme.com.");
  if (isReservedDomain(domain)) {
    throw new DomainError("not_allowed", "That domain cannot receive mail here.");
  }
  if ((await allowance(account)) <= 0) {
    throw new DomainError(
      "plan_required",
      account.kind === "team"
        ? "Custom domains come with Team Business."
        : "Custom domains are part of Business.",
      403
    );
  }
  const existing = await listDomains(account);
  if (existing.some((row) => row.domain === domain)) {
    throw new DomainError("exists", "That domain is already on your list.", 409);
  }
  if (existing.length >= MAX_DOMAINS_PER_ACCOUNT) {
    throw new DomainError("too_many", `At most ${MAX_DOMAINS_PER_ACCOUNT} domains.`);
  }
  const admin = createAdminClient();
  const { error } = await admin.from("inbound_domains").insert({
    domain,
    user_id: account.kind === "user" ? account.userId : null,
    team_id: account.kind === "team" ? account.teamId : null,
  });
  if (error) throw error;
  const added = (await listDomains(account)).find((row) => row.domain === domain);
  if (!added) throw new Error("The domain was not saved");
  return added;
}

async function ownedRow(account: DomainAccount, id: string): Promise<DomainRow> {
  const admin = createAdminClient();
  const owner = ownerFilter(account);
  const { data, error } = await admin
    .from("inbound_domains")
    .select(DOMAIN_COLUMNS)
    .eq("id", id)
    .eq(owner.column, owner.value)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new DomainError("not_found", "Domain not found", 404);
  return data as unknown as DomainRow;
}

/**
 * Looks the records up now. Both in place: the domain is verified (unless
 * another account holds it). The answer says which records are missing.
 */
export async function verifyDomain(
  account: DomainAccount,
  id: string,
  resolver: DomainResolver = systemResolver
): Promise<{ domain: InboundDomain; records: { txt: boolean; mx: boolean } }> {
  const row = await ownedRow(account, id);
  const records = await checkRecords(row.domain, row.token, resolver);
  const admin = createAdminClient();
  const now = new Date().toISOString();
  if (records.txt && records.mx) {
    const { error } = await admin
      .from("inbound_domains")
      .update({
        status: "verified",
        verified_at: row.verified_at ?? now,
        last_checked_at: now,
        failed_checks: 0,
      })
      .eq("id", id);
    if (error) {
      // The partial unique index: another account holds the domain.
      if ((error as { code?: string }).code === "23505") {
        throw new DomainError("held", "Another account already receives mail at that domain.", 409);
      }
      throw error;
    }
  } else {
    const { error } = await admin
      .from("inbound_domains")
      .update({ last_checked_at: now })
      .eq("id", id);
    if (error) throw error;
  }
  const domain = (await listDomains(account)).find((row) => row.id === id)!;
  return { domain, records };
}

/** Endpoints a domain may route to: the owner's own, or those shared with the team. */
async function routableEndpointIds(account: DomainAccount, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const admin = createAdminClient();
  if (account.kind === "user") {
    const { data, error } = await admin
      .from("endpoints")
      .select("id")
      .in("id", ids)
      .eq("user_id", account.userId);
    if (error) throw error;
    return new Set((data ?? []).map((row: { id: string }) => row.id));
  }
  const { data, error } = await admin
    .from("team_endpoints")
    .select("endpoint_id")
    .in("endpoint_id", ids)
    .eq("team_id", account.teamId);
  if (error) throw error;
  return new Set((data ?? []).map((row: { endpoint_id: string }) => row.endpoint_id));
}

/** Replaces a domain's routing: the catch-all endpoint and the local parts. */
export async function setDomainRouting(
  account: DomainAccount,
  id: string,
  routing: { catchAllEndpointId: string | null; routes: DomainRoute[] }
): Promise<InboundDomain> {
  await ownedRow(account, id);
  if (routing.routes.length > MAX_ROUTES_PER_DOMAIN) {
    throw new DomainError("bad_route", `At most ${MAX_ROUTES_PER_DOMAIN} addresses per domain.`);
  }
  const seen = new Set<string>();
  const routes = routing.routes.map((route) => {
    const localPart = route.localPart.trim().toLowerCase();
    if (!LOCAL_PART.test(localPart)) {
      throw new DomainError(
        "bad_route",
        `"${route.localPart}" is not an address name: letters, digits, dots, - and _.`
      );
    }
    if (seen.has(localPart)) {
      throw new DomainError("bad_route", `"${localPart}" is listed twice.`);
    }
    seen.add(localPart);
    return { localPart, endpointId: route.endpointId };
  });
  const wanted = [
    ...new Set([
      ...routes.map((route) => route.endpointId),
      ...(routing.catchAllEndpointId ? [routing.catchAllEndpointId] : []),
    ]),
  ];
  const allowed = await routableEndpointIds(account, wanted);
  if (wanted.some((endpointId) => !allowed.has(endpointId))) {
    throw new DomainError(
      "bad_route",
      account.kind === "team"
        ? "Route only to endpoints shared with the team."
        : "Route only to your own endpoints."
    );
  }

  const admin = createAdminClient();
  const { error: domainError } = await admin
    .from("inbound_domains")
    .update({ catch_all_endpoint_id: routing.catchAllEndpointId })
    .eq("id", id);
  if (domainError) throw domainError;
  const { error: deleteError } = await admin
    .from("inbound_domain_routes")
    .delete()
    .eq("domain_id", id);
  if (deleteError) throw deleteError;
  if (routes.length > 0) {
    const { error: insertError } = await admin.from("inbound_domain_routes").insert(
      routes.map((route) => ({
        domain_id: id,
        local_part: route.localPart,
        endpoint_id: route.endpointId,
      }))
    );
    if (insertError) throw insertError;
  }
  return (await listDomains(account)).find((row) => row.id === id)!;
}

export async function deleteDomain(account: DomainAccount, id: string): Promise<void> {
  await ownedRow(account, id);
  const admin = createAdminClient();
  const { error } = await admin.from("inbound_domains").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Looks the records of verified and lapsed domains up again, once a day
 * each: a verified domain lapses after LAPSE_AFTER_FAILED_CHECKS failed
 * checks in a row (its mail is then refused), and a lapsed one comes back
 * when the records are there again.
 */
export async function recheckDomains(
  resolver: DomainResolver = systemResolver,
  limit = 50
): Promise<{ checked: number; lapsed: number; restored: number }> {
  const admin = createAdminClient();
  const due = new Date(Date.now() - RECHECK_AFTER_MS).toISOString();
  const { data, error } = await admin
    .from("inbound_domains")
    .select(DOMAIN_COLUMNS)
    .neq("status", "pending")
    .or(`last_checked_at.is.null,last_checked_at.lt.${due}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  let lapsed = 0;
  let restored = 0;
  const rows = (data ?? []) as unknown as DomainRow[];
  for (const row of rows) {
    let ok: boolean;
    try {
      const records = await checkRecords(row.domain, row.token, resolver);
      ok = records.txt && records.mx;
    } catch (lookupError) {
      // A resolver that fails is not the customer's records being gone.
      reportError("[domains] DNS lookup failed", lookupError);
      continue;
    }
    const failed = ok ? 0 : row.failed_checks + 1;
    const status = ok ? "verified" : failed >= LAPSE_AFTER_FAILED_CHECKS ? "lapsed" : row.status;
    if (status === "lapsed" && row.status !== "lapsed") lapsed++;
    if (status === "verified" && row.status === "lapsed") restored++;
    const { error: updateError } = await admin
      .from("inbound_domains")
      .update({
        status,
        failed_checks: failed,
        last_checked_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    // Restoring may collide with another account that verified it meanwhile.
    if (updateError && (updateError as { code?: string }).code !== "23505") throw updateError;
  }
  return { checked: rows.length, lapsed, restored };
}

const globalForChecker = globalThis as unknown as {
  __domainChecker?: ReturnType<typeof setInterval>;
};

/** Runs recheckDomains every hour (each domain is due once a day). */
export function startDomainChecker(): void {
  if (globalForChecker.__domainChecker) return;
  const tick = async () => {
    try {
      const result = await recheckDomains();
      if (result.lapsed || result.restored) {
        console.info(
          `[domains] checked=${result.checked} lapsed=${result.lapsed} restored=${result.restored}`
        );
      }
    } catch (error) {
      reportError("[domains] recheck failed", error);
    }
  };
  globalForChecker.__domainChecker = setInterval(() => void tick(), 60 * 60 * 1000);
  void tick();
}

/** Whether an email address is at a domain that receives mail here (not to become an account email). */
export async function isInboundDomainAddress(email: string): Promise<boolean> {
  const domain = normalizeDomain(email.slice(email.lastIndexOf("@") + 1));
  if (!domain) return false;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("inbound_domains")
    .select("id")
    .eq("domain", domain)
    .neq("status", "pending")
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
