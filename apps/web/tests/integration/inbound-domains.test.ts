import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  addDomain,
  listDomains,
  recheckDomains,
  setDomainRouting,
  verifyDomain,
  deleteDomain,
  isInboundDomainAddress,
  type DomainResolver,
} from "@/lib/supabase/inbound-domains";

/**
 * Custom inbound domains (migration 00072) against the local database: who
 * may add one, verification against DNS (a fake resolver), routing by local
 * part and catch-all, what resolve_inbound_recipient answers the receiver,
 * the plan's allowance, lapsing and coming back.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
let counter = 0;
const userIds: string[] = [];

afterAll(async () => {
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function createUser(fields: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-domains-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  userIds.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  return id;
}

async function createEndpoint(userId: string, name: string) {
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `dom-${name}-${counter}-${ts}`, name, user_id: userId })
    .select("id, slug")
    .single();
  if (error) throw error;
  return data as { id: string; slug: string };
}

/** DNS with the records each domain has (by the domain's name). */
function dns(records: Record<string, { txt?: string[]; mx?: string[] }>): DomainResolver {
  return {
    txt: async (name) => records[name.replace(/^_mailhooks\./, "")]?.txt ?? [],
    mx: async (domain) => records[domain]?.mx ?? [],
  };
}

function inPlace(domain: { domain: string; records: { txt: { value: string } } }) {
  return { [domain.domain]: { txt: [domain.records.txt.value], mx: ["mx.mailhooks.cc"] } };
}

async function resolve(domain: string, local: string) {
  const { data, error } = await admin.rpc("resolve_inbound_recipient", {
    p_domain: domain,
    p_local: local,
  });
  if (error) throw error;
  return data as { status: string; slug?: string };
}

describe("custom inbound domains", () => {
  it("are part of Business, and never the capture domain or this app's hosts", async () => {
    const free = await createUser();
    await expect(
      addDomain({ kind: "user", userId: free }, `in-${ts}.acme.example`)
    ).rejects.toMatchObject({ code: "plan_required" });

    const business = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: business };
    for (const domain of ["mailhooks.cc", "x.mailhooks.cc", "go.webhooks.cc", "webhooks.cc"]) {
      await expect(addDomain(account, domain)).rejects.toMatchObject({ code: "not_allowed" });
    }
    await expect(addDomain(account, "not a domain")).rejects.toMatchObject({ code: "invalid" });

    const added = await addDomain(account, `In-${ts}.Acme.Example.`);
    expect(added).toMatchObject({
      domain: `in-${ts}.acme.example`,
      status: "pending",
      active: false,
      records: {
        txt: { name: `_mailhooks.in-${ts}.acme.example` },
        mx: { name: `in-${ts}.acme.example`, value: "mx.mailhooks.cc" },
      },
    });
    expect(added.records.txt.value).toMatch(/^mailhooks-verify=[0-9a-f]{32}$/);
    await expect(addDomain(account, `in-${ts}.acme.example`)).rejects.toMatchObject({
      code: "exists",
    });
  });

  it("verify against DNS, route by local part or catch-all, and refuse what is not theirs", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const other = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: owner };
    const orders = await createEndpoint(owner, "orders");
    const everything = await createEndpoint(owner, "all");
    const foreign = await createEndpoint(other, "foreign");
    const domain = await addDomain(account, `route-${ts}.acme.example`);

    // Nothing in DNS yet, then only the TXT record.
    let result = await verifyDomain(account, domain.id, dns({}));
    expect(result.records).toEqual({ txt: false, mx: false });
    expect(result.domain.status).toBe("pending");
    result = await verifyDomain(
      account,
      domain.id,
      dns({ [domain.domain]: { txt: [domain.records.txt.value] } })
    );
    expect(result.records).toEqual({ txt: true, mx: false });
    expect(await resolve(domain.domain, "orders")).toEqual({ status: "relay_denied" });

    result = await verifyDomain(account, domain.id, dns(inPlace(domain)));
    expect(result.domain).toMatchObject({ status: "verified", active: true });
    // Verified, but routed nowhere yet.
    expect(await resolve(domain.domain, "orders")).toEqual({ status: "unknown" });

    await expect(
      setDomainRouting(account, domain.id, {
        catchAllEndpointId: null,
        routes: [{ localPart: "orders", endpointId: foreign.id }],
      })
    ).rejects.toMatchObject({ code: "bad_route" });
    await expect(
      setDomainRouting(account, domain.id, {
        catchAllEndpointId: null,
        routes: [{ localPart: "bad name!", endpointId: orders.id }],
      })
    ).rejects.toMatchObject({ code: "bad_route" });

    const routed = await setDomainRouting(account, domain.id, {
      catchAllEndpointId: everything.id,
      routes: [{ localPart: "Orders", endpointId: orders.id }],
    });
    expect(routed.routes).toEqual([{ localPart: "orders", endpointId: orders.id }]);
    expect(await resolve(domain.domain, "orders")).toEqual({ status: "ok", slug: orders.slug });
    expect(await resolve(domain.domain.toUpperCase() + ".", "ORDERS")).toEqual({
      status: "ok",
      slug: orders.slug,
    });
    expect(await resolve(domain.domain, "invoices")).toEqual({
      status: "ok",
      slug: everything.slug,
    });
    expect(await isInboundDomainAddress(`someone@${domain.domain}`)).toBe(true);

    // Another account cannot take a domain whose holder still proves it...
    const otherAccount = { kind: "user" as const, userId: other };
    const copy = await addDomain(otherAccount, domain.domain);
    const both = dns({
      [domain.domain]: {
        txt: [domain.records.txt.value, copy.records.txt.value],
        mx: ["mx.mailhooks.cc"],
      },
    });
    await expect(verifyDomain(otherAccount, copy.id, both)).rejects.toMatchObject({
      code: "held",
    });

    // ... but once only its TXT record is there, whoever controls the DNS
    // now has the domain, and the old holder's lapses at once.
    const taken = await verifyDomain(otherAccount, copy.id, dns(inPlace(copy)));
    expect(taken.domain.status).toBe("verified");
    expect((await listDomains(account)).find((row) => row.id === domain.id)?.status).toBe("lapsed");
    await deleteDomain(otherAccount, copy.id);
    await deleteDomain(account, domain.id);
    expect(await resolve(domain.domain, "orders")).toEqual({ status: "relay_denied" });
  });

  it("refuse a domain whose mail is not all ours or where accounts have their email", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: owner };
    const domain = await addDomain(account, `shared-${ts}.acme.example`);
    // A backup MX elsewhere: its mail does not all come here.
    const result = await verifyDomain(
      account,
      domain.id,
      dns({
        [domain.domain]: {
          txt: [domain.records.txt.value],
          mx: ["mx.mailhooks.cc", "mail.elsewhere.example"],
        },
      })
    );
    expect(result.records).toEqual({ txt: true, mx: false });
    expect(result.domain.status).toBe("pending");

    // Test accounts' emails are at webhooks-test.local.
    const accounts = await addDomain(account, "webhooks-test.local");
    await expect(verifyDomain(account, accounts.id, dns(inPlace(accounts)))).rejects.toMatchObject({
      code: "has_accounts",
    });
  });

  it("keep at most 20 per account, even when added at once", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const rows = Array.from({ length: 20 }, (_, i) => ({
      user_id: owner,
      domain: `cap${i}-${ts}.acme.example`,
    }));
    const { error } = await admin.from("inbound_domains").insert(rows);
    if (error) throw error;
    const { error: overError } = await admin
      .from("inbound_domains")
      .insert({ user_id: owner, domain: `cap20-${ts}.acme.example` });
    expect(overError?.code).toBe("P0001");
  });

  it("count against the plan in the order they were verified, and stop with it", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: owner };
    const endpoint = await createEndpoint(owner, "catch");
    const first = await addDomain(account, `one-${ts}.acme.example`);
    const second = await addDomain(account, `two-${ts}.acme.example`);
    for (const domain of [first, second]) {
      await verifyDomain(account, domain.id, dns(inPlace(domain)));
      await setDomainRouting(account, domain.id, { catchAllEndpointId: endpoint.id, routes: [] });
    }
    const listed = await listDomains(account);
    expect(listed.map((domain) => [domain.domain, domain.active])).toEqual([
      [first.domain, true],
      [second.domain, false],
    ]);
    expect((await resolve(first.domain, "x")).status).toBe("ok");
    expect((await resolve(second.domain, "x")).status).toBe("relay_denied");

    // An extra domain bought makes room for the second.
    await admin.from("users").update({ extra_domains: 1 }).eq("id", owner);
    expect((await resolve(second.domain, "x")).status).toBe("ok");

    // Down to Pro: none receive mail, even before the extra domains are
    // taken off the account.
    await admin.from("users").update({ plan: "pro" }).eq("id", owner);
    expect((await resolve(first.domain, "x")).status).toBe("relay_denied");
    expect((await resolve(second.domain, "x")).status).toBe("relay_denied");
  });

  it("lapse after three failed checks and come back when the records return", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: owner };
    const endpoint = await createEndpoint(owner, "lapse");
    const domain = await addDomain(account, `lapse-${ts}.acme.example`);
    await verifyDomain(account, domain.id, dns(inPlace(domain)));
    await setDomainRouting(account, domain.id, { catchAllEndpointId: endpoint.id, routes: [] });

    const due = async (days = 2) =>
      admin
        .from("inbound_domains")
        .update({ last_checked_at: new Date(Date.now() - days * 86_400_000).toISOString() })
        .eq("id", domain.id);
    const state = async () =>
      (
        await admin
          .from("inbound_domains")
          .select("status, failed_checks")
          .eq("id", domain.id)
          .single()
      ).data;

    for (let check = 1; check <= 3; check++) {
      await due();
      await recheckDomains(dns({}), 1000);
    }
    expect(await state()).toEqual({ status: "lapsed", failed_checks: 3 });
    expect((await resolve(domain.domain, "x")).status).toBe("relay_denied");

    // A lapsed domain is looked up weekly, not daily.
    await due(2);
    await recheckDomains(dns(inPlace(domain)), 1000);
    expect(await state()).toEqual({ status: "lapsed", failed_checks: 3 });
    await due(8);
    await recheckDomains(dns(inPlace(domain)), 1000);
    expect(await state()).toEqual({ status: "verified", failed_checks: 0 });
    expect((await resolve(domain.domain, "x")).status).toBe("ok");

    // A check the owner asks for counts too: a domain the owner no longer
    // controls cannot be kept verified by checking it every day.
    for (let check = 1; check <= 3; check++) {
      await verifyDomain(account, domain.id, dns({}));
    }
    expect(await state()).toEqual({ status: "lapsed", failed_checks: 3 });

    // A nameserver that fails is no failed check, but the domain waits its turn again.
    await due(8);
    const failing: DomainResolver = {
      txt: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      },
      mx: async () => [],
    };
    await recheckDomains(failing, 1000);
    const { data: stamped } = await admin
      .from("inbound_domains")
      .select("status, failed_checks, last_checked_at")
      .eq("id", domain.id)
      .single();
    expect(stamped).toMatchObject({ status: "lapsed", failed_checks: 3 });
    expect(Date.now() - Date.parse(stamped!.last_checked_at)).toBeLessThan(60_000);
  });
});

// The receiver's private mail API (needs `make dev-receiver`; the receiver
// reads verified domains again every INBOUND_DOMAINS_REFRESH_SECS).
const MAIL_URL = (process.env.MAIL_INGEST_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");

async function signedPost(path: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", process.env.CAPTURE_SHARED_SECRET!)
    .update(`${timestamp}.POST.${path}.`)
    .update(body)
    .digest("hex");
  const response = await fetch(`${MAIL_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-timestamp": String(timestamp),
      "x-mail-signature": signature,
    },
    body,
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function checkAddress(address: string): Promise<string> {
  return ((await signedPost("/internal/mail/check", { address })) as { status: string }).status;
}

/** The receiver's answer once its view of the domains caught up (a few seconds at most). */
async function eventually(address: string, wanted: string): Promise<string> {
  let status = await checkAddress(address);
  for (let i = 0; i < 40 && status !== wanted; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await checkAddress(address);
  }
  return status;
}

describe("mail at a custom domain, through the receiver", () => {
  it("lands on the routed endpoint, and is refused when unknown, unverified or lapsed", async () => {
    const owner = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId: owner };
    const orders = await createEndpoint(owner, "mail");
    const domain = await addDomain(account, `mail-${ts}.acme.example`);
    await verifyDomain(account, domain.id, dns(inPlace(domain)));
    await setDomainRouting(account, domain.id, {
      catchAllEndpointId: null,
      routes: [{ localPart: "orders", endpointId: orders.id }],
    });

    expect(await eventually(`Orders+Shop@${domain.domain}`, "ok")).toBe("ok");
    expect(await checkAddress(`nobody@${domain.domain}`)).toBe("unknown");
    expect(await checkAddress(`orders@never-${ts}.acme.example`)).toBe("relay_denied");

    const raw = [
      `From: Acme Store <store@acme.example>`,
      `To: orders@${domain.domain}`,
      `Subject: Order 7 placed`,
      `Message-ID: <custom-${ts}@acme.example>`,
      "",
      "Thanks for your order.",
      "",
    ].join("\r\n");
    const delivered = (await signedPost("/internal/mail/deliver", {
      recipients: [`orders+shop@${domain.domain}`, `someone@never-${ts}.acme.example`],
      envelope_from: "store@acme.example",
      client_ip: "192.0.2.25",
      client_rdns: null,
      helo: "mail.acme.example",
      tls: null,
      auth: null,
      spam: null,
      received_at: new Date().toISOString(),
      retry: false,
      raw: Buffer.from(raw).toString("base64"),
    })) as { results: { recipient: string; status: string; request_id?: string }[] };
    expect(delivered.results.map((result) => result.status)).toEqual(["captured", "relay_denied"]);

    const { data: request } = await admin
      .from("requests")
      .select("endpoint_id, path, kind, email")
      .eq("id", delivered.results[0].request_id!)
      .single();
    expect(request).toMatchObject({
      endpoint_id: orders.id,
      path: `orders+shop@${domain.domain}`,
      kind: "email",
    });
    expect((request!.email as { tag: string | null }).tag).toBe("shop");

    await admin.from("inbound_domains").update({ status: "lapsed" }).eq("id", domain.id);
    expect(await eventually(`orders@${domain.domain}`, "relay_denied")).toBe("relay_denied");
  });
});
