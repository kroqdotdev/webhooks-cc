import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  cancelRequestSearch,
  countSearchRequests,
  InvalidSearchCursorError,
  searchRequestPage,
  type SearchRequestRecord,
} from "@/lib/supabase/search";

// search_requests_page() (migration 00100): a search reads within a time
// budget and pages backwards through time with a cursor. These tests force
// small budgets so a few thousand rows take several pages.

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN = Date.now();
let ownerId: string;
let otherId: string;
let bigSlug: string;
let bigEndpointId: string;
let smallSlug: string;
let smallEndpointId: string;
let otherSlug: string;

const BIG_ROWS = 3000;
const NEEDLE = `needle-${RUN}`;
// Rows that carry the needle, by index into the big endpoint's rows.
const NEEDLE_AT = [5, 777, 1500, 2222, 2999];

async function createUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-search-bounded-${label}-${RUN}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

function row(
  endpointId: string,
  userId: string,
  receivedAt: number,
  extra: Record<string, unknown>
) {
  return {
    endpoint_id: endpointId,
    user_id: userId,
    method: "POST",
    path: "/hook",
    headers: { "content-type": "application/json" },
    body: '{"event":"filler"}',
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: 18,
    received_at: new Date(receivedAt).toISOString(),
    // A bulk insert sends every column any row has, so each row names them.
    kind: "http",
    email: null,
    ...extra,
  };
}

async function insertRows(rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await admin.from("requests").insert(rows.slice(i, i + 1000));
    if (error) throw error;
  }
}

/** Pages a search to the end; returns every request in order and the page count. */
async function searchAll(
  input: Parameters<typeof searchRequestPage>[0]
): Promise<{ requests: SearchRequestRecord[]; pages: number }> {
  const requests: SearchRequestRecord[] = [];
  let cursor = input.cursor;
  for (let pages = 1; pages <= 500; pages++) {
    const page = await searchRequestPage({ ...input, cursor });
    requests.push(...page.requests);
    if (page.complete) {
      expect(page.cursor).toBeNull();
      return { requests, pages };
    }
    expect(page.cursor).toBeTruthy();
    cursor = page.cursor!;
  }
  throw new Error("search did not finish in 500 pages");
}

describe("bounded request search", () => {
  beforeAll(async () => {
    ownerId = await createUser("owner");
    otherId = await createUser("other");

    const big = await createEndpointForUser({ userId: ownerId, name: "Bounded search big" });
    bigSlug = big.slug;
    bigEndpointId = big.id;
    const small = await createEndpointForUser({ userId: ownerId, name: "Bounded search small" });
    smallSlug = small.slug;
    smallEndpointId = small.id;
    const other = await createEndpointForUser({ userId: otherId, name: "Bounded search other" });
    otherSlug = other.slug;

    // 3000 rows a second apart over the last hour, newest first by index.
    const now = Date.now();
    await insertRows(
      Array.from({ length: BIG_ROWS }, (_, i) =>
        row(bigEndpointId, ownerId, now - 60_000 - i * 1_000, {
          body: NEEDLE_AT.includes(i)
            ? `{"event":"filler","ref":"${NEEDLE}-${i}"}`
            : '{"event":"filler"}',
        })
      )
    );

    // The small endpoint: wildcard characters, case, a decoded email, ties.
    const t = now - 5 * 60_000;
    await insertRows([
      row(smallEndpointId, ownerId, t - 1_000, { body: `{"ref":"ord_rare_${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 2_000, { body: `{"ref":"ordXrare_${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 3_000, { body: `{"ref":"100%_done_${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 4_000, { body: `{"ref":"1000_done_${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 5_000, { body: `{"provider":"Stripe","run":"${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 6_000, { body: `{"name":"SØREN-${RUN}"}` }),
      row(smallEndpointId, ownerId, t - 7_000, {
        kind: "email",
        path: "inbox@example.com",
        content_type: "message/rfc822",
        headers: { subject: "=?UTF-8?B?SW52b2ljZQ==?=" },
        // The raw message carries the subject encoded and the text base64'd.
        body: "Subject: =?UTF-8?B?SW52b2ljZQ==?=\r\nContent-Transfer-Encoding: base64\r\n\r\nUGF5bWVudA==",
        email: {
          subject: `Invoice decoded-${RUN}`,
          text: `Payment received for order decoded-text-${RUN}`,
          from: [{ name: "Acme Billing", address: `billing-${RUN}@acme.example` }],
          to: [{ name: null, address: "inbox@example.com" }],
          cc: [],
        },
      }),
      // Ten rows at the very same instant.
      ...Array.from({ length: 10 }, (_, i) =>
        row(smallEndpointId, ownerId, t - 60_000, { body: `{"tie":"tie-${RUN}","n":${i}}` })
      ),
    ]);
  }, 120_000);

  afterAll(async () => {
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (otherId) await admin.auth.admin.deleteUser(otherId);
  });

  it("finds a common term at once, newest first, with a cursor to continue", async () => {
    const page = await searchRequestPage({
      userId: ownerId,
      slug: bigSlug,
      q: "filler",
      limit: 50,
    });
    expect(page.requests).toHaveLength(50);
    expect(page.complete).toBe(false);
    expect(page.cursor).toBeTruthy();
    const times = page.requests.map((r) => r.receivedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("stops at its time budget and pages to every match without gaps or repeats", async () => {
    const first = await searchRequestPage({
      userId: ownerId,
      slug: bigSlug,
      q: NEEDLE,
      budgetMs: 1,
    });
    expect(first.complete).toBe(false);
    expect(first.searchedUntil).not.toBeNull();

    const { requests, pages } = await searchAll({
      userId: ownerId,
      slug: bigSlug,
      q: NEEDLE,
      budgetMs: 1,
      limit: 2,
    });
    expect(pages).toBeGreaterThan(2);
    const refs = requests.map((r) => JSON.parse(r.body ?? "{}").ref);
    expect(refs).toEqual(NEEDLE_AT.map((i) => `${NEEDLE}-${i}`));
  });

  it("pages oldest first too", async () => {
    const { requests } = await searchAll({
      userId: ownerId,
      slug: bigSlug,
      q: NEEDLE,
      budgetMs: 1,
      limit: 3,
      order: "asc",
    });
    const refs = requests.map((r) => JSON.parse(r.body ?? "{}").ref);
    expect(refs).toEqual([...NEEDLE_AT].reverse().map((i) => `${NEEDLE}-${i}`));
  });

  it("pages through rows that share one instant", async () => {
    const { requests } = await searchAll({
      userId: ownerId,
      slug: smallSlug,
      q: `tie-${RUN}`,
      limit: 3,
    });
    expect(requests).toHaveLength(10);
    expect(new Set(requests.map((r) => r.id)).size).toBe(10);
  });

  it("treats % and _ as literal characters", async () => {
    const underscore = await searchRequestPage({
      userId: ownerId,
      slug: smallSlug,
      q: `ord_rare_${RUN}`,
    });
    expect(underscore.requests.map((r) => r.body)).toEqual([`{"ref":"ord_rare_${RUN}"}`]);

    const percent = await searchRequestPage({
      userId: ownerId,
      slug: smallSlug,
      q: `100%_done_${RUN}`,
    });
    expect(percent.requests.map((r) => r.body)).toEqual([`{"ref":"100%_done_${RUN}"}`]);
  });

  it("ignores case for ASCII and non-ASCII terms", async () => {
    const ascii = await searchRequestPage({
      userId: ownerId,
      slug: smallSlug,
      q: `STRIPE","RUN":"${RUN}`,
    });
    expect(ascii.requests).toHaveLength(1);

    const nonAscii = await searchRequestPage({
      userId: ownerId,
      slug: smallSlug,
      q: `søren-${RUN}`,
    });
    expect(nonAscii.requests).toHaveLength(1);
  });

  it("matches an email's decoded subject, text and sender", async () => {
    for (const q of [`Invoice decoded-${RUN}`, `decoded-text-${RUN}`, `billing-${RUN}@acme`]) {
      const page = await searchRequestPage({ userId: ownerId, slug: smallSlug, q, kind: "email" });
      expect(page.requests.map((r) => r.kind)).toEqual(["email"]);
    }
  });

  it("finds a request by its id first", async () => {
    const { data } = await admin
      .from("requests")
      .select("id")
      .eq("endpoint_id", bigEndpointId)
      .order("received_at", { ascending: true })
      .limit(1)
      .single();
    const id = (data as { id: string }).id;

    const page = await searchRequestPage({ userId: ownerId, slug: bigSlug, q: id.toUpperCase() });
    expect(page.requests[0]?.id).toBe(id);

    const anywhere = await searchRequestPage({ userId: ownerId, q: id });
    expect(anywhere.requests[0]?.id).toBe(id);

    // Not someone else's request.
    const stranger = await searchRequestPage({ userId: otherId, q: id });
    expect(stranger.requests).toHaveLength(0);
  });

  it("counts exactly without a term and as a lower bound when the budget runs out", async () => {
    const total = await countSearchRequests({ userId: ownerId, slug: bigSlug });
    expect(total).toMatchObject({ count: BIG_ROWS, exact: true });

    const partial = await countSearchRequests({
      userId: ownerId,
      slug: bigSlug,
      q: NEEDLE,
      budgetMs: 1,
    });
    expect(partial.exact).toBe(false);
    expect(partial.cursor).toBeTruthy();

    // The counts of each stretch add up to the whole.
    let sum = partial.count;
    let cursor = partial.cursor ?? undefined;
    while (cursor) {
      const next = await countSearchRequests({
        userId: ownerId,
        slug: bigSlug,
        q: NEEDLE,
        budgetMs: 1,
        cursor,
      });
      sum += next.count;
      cursor = next.exact ? undefined : (next.cursor ?? undefined);
    }
    expect(sum).toBe(NEEDLE_AT.length);
  });

  it("answers nothing, at once, for an endpoint the caller cannot see", async () => {
    const page = await searchRequestPage({ userId: ownerId, slug: otherSlug, q: "filler" });
    expect(page).toMatchObject({ requests: [], complete: true, cursor: null });
    const count = await countSearchRequests({ userId: ownerId, slug: otherSlug });
    expect(count).toMatchObject({ count: 0, exact: true });
  });

  it("applies an offset once across pages that stop early", async () => {
    // Every match after the first two, paged with a budget that stops each
    // page before it finds many.
    const { requests } = await searchAll({
      userId: ownerId,
      slug: bigSlug,
      q: NEEDLE,
      offset: 2,
      limit: 2,
      budgetMs: 1,
    });
    const refs = requests.map((r) => JSON.parse(r.body ?? "{}").ref);
    expect(refs).toEqual(NEEDLE_AT.slice(2).map((i) => `${NEEDLE}-${i}`));
  });

  it("takes only cursors it issued", async () => {
    // A made-up position, even a well-formed one, is refused: the database
    // clamps positions to the range too (lab-tested), but a forged cursor
    // must not reach it at all.
    const crafted = Buffer.from(
      "a|-infinity|00000000-0000-0000-0000-000000000000",
      "utf8"
    ).toString("base64url");
    await expect(
      searchRequestPage({
        userId: ownerId,
        slug: bigSlug,
        q: NEEDLE,
        order: "asc",
        cursor: crafted,
      })
    ).rejects.toBeInstanceOf(InvalidSearchCursorError);

    const page = await searchRequestPage({ userId: ownerId, slug: bigSlug, q: "filler", limit: 1 });
    expect(page.cursor).toBeTruthy();
    // A cursor is a position only: another account using it still sees
    // nothing of this endpoint.
    const stranger = await searchRequestPage({
      userId: otherId,
      slug: bigSlug,
      q: "filler",
      cursor: page.cursor!,
    });
    expect(stranger.requests).toHaveLength(0);
    // Tampering with the position breaks the signature.
    const [position, mac] = page.cursor!.split(".");
    const tampered = `${Buffer.from(
      Buffer.from(position, "base64url")
        .toString("utf8")
        .replace(/^d\|[^|]+/, "d|infinity"),
      "utf8"
    ).toString("base64url")}.${mac}`;
    await expect(
      searchRequestPage({ userId: ownerId, slug: bigSlug, q: "filler", cursor: tampered })
    ).rejects.toBeInstanceOf(InvalidSearchCursorError);
  });

  it("counts one kind of an endpoint exactly", async () => {
    const http = await countSearchRequests({ userId: ownerId, slug: smallSlug, kind: "http" });
    const email = await countSearchRequests({ userId: ownerId, slug: smallSlug, kind: "email" });
    const all = await countSearchRequests({ userId: ownerId, slug: smallSlug });
    expect(http.exact && email.exact && all.exact).toBe(true);
    expect(email.count).toBe(1);
    expect(http.count + email.count).toBe(all.count);
  });

  it("counts every endpoint exactly without a term", async () => {
    const all = await countSearchRequests({ userId: ownerId });
    expect(all.exact).toBe(true);
    // The big and small endpoints' rows, nothing of the other account's.
    const big = await countSearchRequests({ userId: ownerId, slug: bigSlug });
    const small = await countSearchRequests({ userId: ownerId, slug: smallSlug });
    expect(all.count).toBe(big.count + small.count);
  });

  it("stops a search whose caller cancelled it", async () => {
    const cancelToken = crypto.randomUUID();
    await cancelRequestSearch(cancelToken);
    const page = await searchRequestPage({
      userId: ownerId,
      slug: bigSlug,
      q: `absent-${RUN}`,
      budgetMs: 10_000,
      cancelToken,
    });
    // The cancel was recorded first, so the walk stops after its first slice.
    expect(page.complete).toBe(false);
    expect(page.cursor).toBeTruthy();
    expect(page.slices).toBe(1);
  });

  it("refuses a cursor it did not issue, or one for the other order", async () => {
    await expect(
      searchRequestPage({ userId: ownerId, slug: bigSlug, q: "x", cursor: "not a cursor" })
    ).rejects.toBeInstanceOf(InvalidSearchCursorError);

    const page = await searchRequestPage({ userId: ownerId, slug: bigSlug, q: "filler", limit: 1 });
    await expect(
      searchRequestPage({
        userId: ownerId,
        slug: bigSlug,
        q: "filler",
        order: "asc",
        cursor: page.cursor!,
      })
    ).rejects.toBeInstanceOf(InvalidSearchCursorError);
  });
});
