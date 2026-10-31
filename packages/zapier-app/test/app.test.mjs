/**
 * The Zapier app against a running web app (WHK_BASE_URL, the dev server by
 * default) and its Supabase stack (read from apps/web/.env.local): the
 * connection test, an endpoint created and listed, a test email sent, the
 * New Email trigger's samples, subscribe and unsubscribe (a destination
 * added and removed), a hook delivery, and Find Email. Skipped when the web
 * app is not running.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import zapier from "zapier-platform-core";
import App from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const appTester = zapier.createAppTester(App);
process.env.WHK_BASE_URL = process.env.WHK_BASE_URL || "http://localhost:3000";

function devEnv() {
  try {
    const text = readFileSync(path.join(here, "../../../apps/web/.env.local"), "utf8");
    const env = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

const env = devEnv();
const SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
let running = false;
let userId = null;
let apiKey = null;

async function admin(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  try {
    const health = await fetch(`${process.env.WHK_BASE_URL}/api/health`);
    running = health.ok && !!SUPABASE_URL && !!SERVICE_KEY;
  } catch {
    running = false;
  }
  if (!running) return;
  const user = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: `test-zapier-${Date.now()}@webhooks-test.local`,
      password: randomBytes(12).toString("hex"),
      email_confirm: true,
    }),
  });
  userId = user.id;
  await admin(`/rest/v1/users?id=eq.${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ plan: "business", subscription_status: "active" }),
  });
  apiKey = `whcc_${randomBytes(24).toString("hex")}`;
  await admin("/rest/v1/api_keys", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      key_hash: createHash("sha256").update(apiKey).digest("hex"),
      key_prefix: apiKey.slice(0, 12),
      name: "Zapier test",
    }),
  });
}, 30_000);

afterAll(async () => {
  if (userId) await admin(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
});

describe("the Zapier app", () => {
  it("connects, makes an endpoint, and turns its emails into Zap records", async (context) => {
    if (!running) context.skip();
    const authData = { apiKey };
    const usage = await appTester(App.authentication.test, { authData });
    expect(usage).toBeTruthy();

    const endpoint = await appTester(App.creates.create_endpoint.operation.perform, {
      authData,
      inputData: { name: "Zapier orders" },
    });
    expect(endpoint.slug).toBeTruthy();
    // Mapped into Send Test Email, the id must be the slug.
    expect(endpoint.id).toBe(endpoint.slug);
    const slug = endpoint.slug;

    const listed = await appTester(App.triggers.endpoint.operation.perform, { authData });
    expect(listed).toContainEqual(expect.objectContaining({ id: slug, name: "Zapier orders" }));

    const sent = await appTester(App.creates.send_test_email.operation.perform, {
      authData,
      inputData: { endpoint: slug },
    });
    // The request id, not the endpoint slug the action falls back to.
    expect(sent.requestId).toBeTruthy();
    expect(sent.id).toBe(sent.requestId);

    // The sample records are the payload a hook delivers.
    const samples = await appTester(App.triggers.new_email.operation.performList, {
      authData,
      inputData: { endpoint: slug },
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toMatchObject({ type: "email.received", endpoint: { slug } });
    expect(samples[0].id).toBeTruthy();
    expect(typeof samples[0].subject).toBe("string");

    // Turning the Zap on adds a destination; a delivery becomes one record.
    const subscription = await appTester(App.triggers.new_email.operation.performSubscribe, {
      authData,
      inputData: { endpoint: slug },
      targetUrl: "https://hooks.zapier.com/hooks/standard/1/abc/",
      meta: { zap: { id: 4242 } },
    });
    expect(subscription).toMatchObject({ endpoint: slug });
    const destinations = await fetch(
      `${process.env.WHK_BASE_URL}/api/endpoints/${slug}/destinations`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    ).then((r) => r.json());
    expect(destinations).toContainEqual(
      expect.objectContaining({
        id: subscription.id,
        url: "https://hooks.zapier.com/hooks/standard/1/abc/",
        name: "Zapier (Zap 4242)",
        format: "json",
        email: true,
        http: false,
      })
    );
    const delivered = await appTester(App.triggers.new_email.operation.perform, {
      authData,
      inputData: { endpoint: slug },
      cleanedRequest: { type: "email.received", data: { id: samples[0].id, subject: "Hi" } },
    });
    expect(delivered).toEqual([{ id: samples[0].id, subject: "Hi", type: "email.received" }]);
    await appTester(App.triggers.new_email.operation.performUnsubscribe, {
      authData,
      subscribeData: subscription,
    });
    const after = await fetch(`${process.env.WHK_BASE_URL}/api/endpoints/${slug}/destinations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).then((r) => r.json());
    expect(after.some((d) => d.id === subscription.id)).toBe(false);
    // Removed already (in the dashboard, say): turning the Zap off still works.
    await appTester(App.triggers.new_email.operation.performUnsubscribe, {
      authData,
      subscribeData: subscription,
    });

    const words = samples[0].subject.split(/\s+/).filter((w) => w.length > 3);
    const found = await appTester(App.searches.find_email.operation.perform, {
      authData,
      inputData: { endpoint: slug, query: words[0] || samples[0].subject },
    });
    expect(found[0]).toMatchObject({ id: samples[0].id, type: "email.received" });
  }, 60_000);

  it("asks Zapier to wait when the API says to slow down", () => {
    const explain = App.afterResponse[0];
    const z = { errors: zapier.errors };
    const response = { status: 429, getHeader: (name) => (name === "retry-after" ? "17" : null) };
    let thrown;
    try {
      explain(response, z);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(zapier.errors.ThrottledError);
    expect(JSON.parse(thrown.message).delay).toBe(17);
  });

  it("explains a key that is not accepted", async (context) => {
    if (!running) context.skip();
    await expect(
      appTester(App.authentication.test, { authData: { apiKey: "whcc_not_a_key" } })
    ).rejects.toThrow(/API key was not accepted/);
  });
});
