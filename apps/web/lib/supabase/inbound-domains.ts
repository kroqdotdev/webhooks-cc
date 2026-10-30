import { Resolver } from "node:dns/promises";
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
 * never by the receiver or the MX host, through public resolvers
 * (DOMAIN_DNS_SERVERS) rather than the host's, so a customer's nameservers
 * never see where we run.
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
      | "bad_route"
      | "has_accounts"
      | "busy"
      | "dns_failed",
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
/** A lapsed domain, less often: it may come back, and most never do. */
const LAPSED_RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
  // A resolver failure (ESERVFAIL) is a failed lookup, not a missing record:
  // it takes the lookup-failure path rather than lapsing a verified domain.
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
    return [];
  }
  throw error;
}

let dnsResolver: Resolver | null = null;

/** Public resolvers with a short timeout: a nameserver that never answers costs seconds, not minutes. */
function resolver(): Resolver {
  if (dnsResolver) return dnsResolver;
  const next = new Resolver({ timeout: 3000, tries: 2 });
  const servers = (process.env.DOMAIN_DNS_SERVERS || "1.1.1.1,1.0.0.1")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  next.setServers(servers);
  dnsResolver = next;
  return next;
}

export const systemResolver: DomainResolver = {
  async txt(name) {
    try {
      return (await resolver().resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (error) {
      return emptyOnMissing(error);
    }
  },
  async mx(domain) {
    try {
      return (await resolver().resolveMx(domain)).map((record) =>
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
): Promise<{ txt: boolean; mx: boolean; txtValues: string[] }> {
  const [txt, mx] = await Promise.all([resolver.txt(txtName(domain)), resolver.mx(domain)]);
  const txtValues = txt.map((value) => value.trim());
  return {
    txt: txtValues.includes(txtValue(token)),
    // Every MX ours: a domain that also receives elsewhere (or lists us as
    // a backup) is not one whose mail comes here.
    mx: mx.length > 0 && mx.every((host) => host === mxHost()),
    // The TXT answer itself, so a takeover decides on the same answer.
    txtValues,
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
  released_at: string | null;
  lookup_failures: number;
}

const DOMAIN_COLUMNS =
  "id, user_id, team_id, domain, token, status, verified_at, last_checked_at, failed_checks, catch_all_endpoint_id, released_at, lookup_failures";

/** Lookups that error in a row (nameservers that never answer) after which a verified domain lapses. */
const LAPSE_AFTER_LOOKUP_FAILURES = 7;
/** A row that lost its domain to another account cannot take it back by hand for this long. */
const RELEASED_HOLD_MS = 24 * 60 * 60 * 1000;

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
  if (error) {
    // The cap again, under the owner's lock (two adds at once), or the same domain twice.
    if ((error as { code?: string }).code === "WHD01") {
      throw new DomainError("too_many", `At most ${MAX_DOMAINS_PER_ACCOUNT} domains.`);
    }
    if ((error as { code?: string }).code === "23505") {
      throw new DomainError("exists", "That domain is already on your list.", 409);
    }
    throw error;
  }
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
 * Records one check of a domain's records. In place: verified (a lapsed one
 * comes back, keeping when it was first verified). Missing on a verified or
 * lapsed domain: one more failed check, lapsing after
 * LAPSE_AFTER_FAILED_CHECKS in a row, whoever asked for the check. A pending
 * domain stays pending. Throws the unique violation when another account
 * holds the domain.
 */
async function recordCheck(row: DomainRow, ok: boolean): Promise<DomainRow["status"]> {
  const admin = createAdminClient();
  const hasAccounts = () =>
    new DomainError(
      "has_accounts",
      "An account here uses an email address at this domain, and its mail would become readable through your endpoints. Use a subdomain that receives no other mail.",
      409
    );
  let current = row;
  // Written only while the row still holds what this check read: two checks
  // at once (the daily one and the owner's) never overwrite each other; the
  // later one reads again and decides from what the other left.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Every way to verified passes here, a lapsed domain coming back too: an
    // account may have signed up at the domain while it was not verified.
    // A verified domain is looked at again as well: a signup that raced its
    // verification (the sign-up hook refuses the domain only once the write
    // is visible) lapses it here, at the latest on the next daily check.
    if (ok && (await domainHasAccounts(current.domain))) {
      if (current.status !== "verified") throw hasAccounts();
      const { error } = await admin
        .from("inbound_domains")
        .update({ status: "lapsed", last_checked_at: new Date().toISOString() })
        .eq("id", current.id)
        .eq("status", "verified");
      if (error) throw error;
      reportError("[domains] a verified domain has an account at it; lapsed", undefined, {
        domainId: current.id,
      });
      return "lapsed";
    }
    const now = new Date().toISOString();
    const failed = ok ? 0 : current.status === "pending" ? 0 : current.failed_checks + 1;
    const status: DomainRow["status"] = ok
      ? "verified"
      : current.status === "pending"
        ? "pending"
        : failed >= LAPSE_AFTER_FAILED_CHECKS
          ? "lapsed"
          : current.status;
    const { data, error } = await admin
      .from("inbound_domains")
      .update({
        status,
        // Verified again after a lapse counts from now: it must not outrank a
        // domain verified while it was away.
        verified_at: ok
          ? current.status === "verified"
            ? current.verified_at
            : now
          : current.verified_at,
        failed_checks: failed,
        lookup_failures: 0,
        last_checked_at: now,
      })
      .eq("id", current.id)
      .eq("status", current.status)
      .eq("failed_checks", current.failed_checks)
      .select("id");
    if (error) throw error;
    if (data && data.length > 0) {
      if (status === "verified" && current.status !== "verified") {
        // A signup that committed between the account check and this write:
        // undo it rather than route that person's mail.
        if (await domainHasAccounts(current.domain)) {
          const { error: undoError } = await admin
            .from("inbound_domains")
            .update({ status: current.status, verified_at: current.verified_at })
            .eq("id", current.id)
            .eq("status", "verified");
          if (undoError) throw undoError;
          throw hasAccounts();
        }
      }
      return status;
    }
    const { data: fresh, error: readError } = await admin
      .from("inbound_domains")
      .select(DOMAIN_COLUMNS)
      .eq("id", current.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!fresh) throw new DomainError("not_found", "Domain not found", 404);
    current = fresh as unknown as DomainRow;
  }
  throw new DomainError("busy", "The domain is being checked. Try again in a moment.", 409);
}

async function domainHasAccounts(domain: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("inbound_domain_has_accounts", {
    p_domain: domain,
  });
  if (error) throw error;
  return data === true;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}

/**
 * Another account's verified row for the same domain, demoted when its own
 * TXT record is gone: whoever controls the domain's DNS now has proved it
 * with theirs. Returns whether the domain is free now.
 */
async function releaseStaleHolder(row: DomainRow, txtValues: string[]): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("inbound_domains")
    .select(DOMAIN_COLUMNS)
    .eq("domain", row.domain)
    .eq("status", "verified")
    .neq("id", row.id)
    .maybeSingle();
  if (error) throw error;
  const holder = data as unknown as DomainRow | null;
  if (!holder) return true;
  if (txtValues.includes(txtValue(holder.token))) return false;
  const now = new Date().toISOString();
  const { error: demoteError } = await admin
    .from("inbound_domains")
    .update({
      status: "lapsed",
      failed_checks: LAPSE_AFTER_FAILED_CHECKS,
      last_checked_at: now,
      released_at: now,
    })
    .eq("id", holder.id)
    .eq("status", "verified");
  if (demoteError) throw demoteError;
  console.info(
    `[domains] released a domain whose records moved to another account holder=${holder.id} by=${row.id}`
  );
  return true;
}

/**
 * Looks the records up now. Both in place: the domain is verified (unless
 * another account still proves it). Missing on a verified domain: counts as
 * a failed check. The answer says which records are missing.
 */
export async function verifyDomain(
  account: DomainAccount,
  id: string,
  resolver: DomainResolver = systemResolver
): Promise<{
  domain: InboundDomain;
  records: { txt: boolean; mx: boolean };
  /** Another account's row lost the domain to this one. */
  tookOver: boolean;
}> {
  const row = await ownedRow(account, id);
  let found: Awaited<ReturnType<typeof checkRecords>>;
  try {
    found = await checkRecords(row.domain, row.token, resolver);
  } catch {
    throw new DomainError("dns_failed", "The DNS lookup failed. Try again in a minute.", 503);
  }
  const records = { txt: found.txt, mx: found.mx };
  const ok = records.txt && records.mx;
  let tookOver = false;
  try {
    await recordCheck(row, ok);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A row that just lost the domain cannot take it straight back: a
    // resolver may still be serving the old records for a while.
    const released = row.released_at ? Date.parse(row.released_at) : NaN;
    if (Number.isFinite(released) && Date.now() - released < RELEASED_HOLD_MS) {
      throw new DomainError(
        "held",
        "Another account verified this domain with its own records. Check again tomorrow if the records are yours again.",
        409
      );
    }
    const free = await releaseStaleHolder(row, found.txtValues);
    if (!free) {
      throw new DomainError(
        "held",
        "Another account receives mail at that domain and its TXT record is still there. If the domain is yours, remove the other mailhooks-verify record and check again.",
        409
      );
    }
    try {
      await recordCheck(row, ok);
      tookOver = true;
    } catch (retryError) {
      if (isUniqueViolation(retryError)) {
        throw new DomainError("held", "Another account already receives mail at that domain.", 409);
      }
      throw retryError;
    }
  }
  const domain = (await listDomains(account)).find((item) => item.id === id)!;
  return { domain, records, tookOver };
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

  // In one transaction: a failure or a second save at once never leaves the domain half routed.
  const { error: routingError } = await createAdminClient().rpc("set_inbound_domain_routes", {
    p_domain_id: id,
    p_catch_all: routing.catchAllEndpointId,
    p_routes: routes.map((route) => ({
      local_part: route.localPart,
      endpoint_id: route.endpointId,
    })),
  });
  if (routingError) throw routingError;
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
  const now = Date.now();
  const due = new Date(now - RECHECK_AFTER_MS).toISOString();
  const lapsedDue = new Date(now - LAPSED_RECHECK_AFTER_MS).toISOString();
  const { data, error } = await admin
    .from("inbound_domains")
    .select(DOMAIN_COLUMNS)
    .neq("status", "pending")
    .or(
      `last_checked_at.is.null,and(status.eq.verified,last_checked_at.lt.${due}),and(status.eq.lapsed,last_checked_at.lt.${lapsedDue})`
    )
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  let lapsed = 0;
  let restored = 0;
  let lookupFailures = 0;
  const rows = (data ?? []) as unknown as DomainRow[];
  for (const row of rows) {
    let ok: boolean;
    try {
      const records = await checkRecords(row.domain, row.token, resolver);
      ok = records.txt && records.mx;
    } catch {
      // A nameserver that fails is not the records being gone: no failed
      // check, but the row is stamped so it waits its turn again and a few
      // dead delegations cannot hold up every other domain's check.
      // Nameservers that never answer, check after check, are not a
      // domain anyone can receive mail at either: it lapses after a week.
      lookupFailures++;
      const failures = row.lookup_failures + 1;
      const lapses = row.status === "verified" && failures >= LAPSE_AFTER_LOOKUP_FAILURES;
      if (lapses) lapsed++;
      const { error: stampError } = await admin
        .from("inbound_domains")
        .update({
          last_checked_at: new Date().toISOString(),
          lookup_failures: failures,
          ...(lapses ? { status: "lapsed" as const } : {}),
        })
        .eq("id", row.id);
      if (stampError) throw stampError;
      continue;
    }
    try {
      const status = await recordCheck(row, ok);
      if (status === "lapsed" && row.status !== "lapsed") lapsed++;
      if (status === "verified" && row.status === "lapsed") restored++;
    } catch (updateError) {
      // Restoring collides with another account that verified it meanwhile,
      // or an account signed up at the domain meanwhile: it stays lapsed,
      // checked again in a week.
      if (
        !isUniqueViolation(updateError) &&
        !(
          updateError instanceof DomainError &&
          (updateError.code === "has_accounts" || updateError.code === "busy")
        )
      ) {
        throw updateError;
      }
      const { error: stampError } = await admin
        .from("inbound_domains")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", row.id);
      if (stampError) throw stampError;
    }
  }
  if (lookupFailures > 0) {
    console.warn(`[domains] DNS lookups failed for ${lookupFailures} of ${rows.length} domains`);
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
      // Every domain due this hour, a batch at a time (bounded per tick).
      const result = { checked: 0, lapsed: 0, restored: 0 };
      for (let batch = 0; batch < 40; batch++) {
        const next = await recheckDomains();
        result.checked += next.checked;
        result.lapsed += next.lapsed;
        result.restored += next.restored;
        if (next.checked < 50) break;
      }
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
    .eq("status", "verified")
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
