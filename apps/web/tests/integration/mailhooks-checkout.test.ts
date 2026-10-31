import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * A checkout started on mailhooks.cc returns there (sessions are per host,
 * so a buyer must land on the site they started on), and one started on
 * webhooks.cc returns to webhooks.cc: Business monthly and annual, from Free
 * and from Pro, as the roadmap's checkout row asks. The request's site comes
 * from the x-whk-site header proxy.ts sets; Polar is a stub.
 */

const site = vi.hoisted(() => ({ value: "webhooks" as "webhooks" | "mailhooks" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-whk-site": site.value }),
}));

const polarMocks = vi.hoisted(() => ({
  createPolarClient: vi.fn(),
  getPolarCheckoutConfig: vi.fn(),
}));
vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: polarMocks.createPolarClient,
    getPolarCheckoutConfig: polarMocks.getPolarCheckoutConfig,
    loggablePolarError: (error: unknown) => error,
  };
});

import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const PASSWORD = "TestPassword123!";
const saved: Record<string, string | undefined> = {};
const userIds: string[] = [];
const checkoutCreate = vi.fn();

beforeAll(() => {
  for (const [key, value] of Object.entries({
    NEXT_PUBLIC_APP_URL: "https://webhooks.example",
    NEXT_PUBLIC_MAILHOOKS_URL: "https://mailhooks.example",
    POLAR_PRO_PRODUCT_ID: "prod_pro_test",
    POLAR_BUSINESS_PRODUCT_ID: "prod_business_test",
    POLAR_BUSINESS_ANNUAL_PRODUCT_ID: "prod_business_year_test",
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

beforeEach(() => {
  checkoutCreate.mockReset();
  checkoutCreate.mockResolvedValue({ url: "https://sandbox.polar.sh/checkout/session" });
  polarMocks.createPolarClient.mockReturnValue({
    // Customer ids are unique per account.
    customers: { create: vi.fn(async () => ({ id: `polar_cust_mail_${Math.random()}` })) },
    checkouts: { create: checkoutCreate },
    subscriptions: { update: vi.fn(), get: vi.fn() },
  });
  polarMocks.getPolarCheckoutConfig.mockReturnValue({
    appUrl: "https://webhooks.example",
    proProductId: "prod_pro_test",
  });
});

async function signedIn(fields: Record<string, unknown>): Promise<string> {
  const email = `test-mail-checkout-${userIds.length}-${Date.now()}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user!.id);
  // Unchecked, a failed update would run the Pro case as Free and still pass.
  const { error: updateError } = await admin.from("users").update(fields).eq("id", data.user!.id);
  if (updateError) throw updateError;
  const client = createClient(process.env.SUPABASE_URL!, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: session, error: signInError } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  return session.session!.access_token;
}

function checkout(token: string, body: Record<string, unknown>) {
  return checkoutRoute(
    new Request("https://mailhooks.example/api/billing/checkout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("checkout return URLs", () => {
  for (const [from, fields] of [
    ["Free", { plan: "free" }],
    ["Pro", { plan: "pro", subscription_status: "canceled" }],
  ] as const) {
    it(`sends a Business buyer from ${from} back to the site they started on`, async () => {
      const token = await signedIn(fields);
      for (const [interval, product] of [
        ["month", "prod_business_test"],
        ["year", "prod_business_year_test"],
      ] as const) {
        for (const [where, origin] of [
          ["mailhooks", "https://mailhooks.example"],
          ["webhooks", "https://webhooks.example"],
        ] as const) {
          site.value = where;
          checkoutCreate.mockClear();
          const response = await checkout(token, { plan: "business", interval });
          expect(response.status, `${from} ${interval} on ${where}`).toBe(200);
          expect(checkoutCreate).toHaveBeenCalledWith(
            expect.objectContaining({
              products: [product],
              success_url: `${origin}/account/plan?upgraded=business`,
            })
          );
        }
      }
    });
  }
});
