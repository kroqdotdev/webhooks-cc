import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Make app's definitions: every file is JSON, every connection, webhook
 * and rpc a module names exists, and the requests they describe work
 * against a running web app (WHK_BASE_URL, the dev server by default, and
 * the Supabase stack in apps/web/.env.local), evaluated with the few IML
 * forms the request templates use: {{a.b}}, {{ifempty(a.b, x)}},
 * {{encodeURL(a.b)}} and comparisons of statusCode. Make itself runs the
 * real thing; this keeps the paths and shapes honest.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function load(dir) {
  return Object.fromEntries(
    readdirSync(path.join(root, dir))
      .filter((name) => name.endsWith(".imljson"))
      .map((name) => [name, JSON.parse(readFileSync(path.join(root, dir, name), "utf8"))])
  );
}

const base = JSON.parse(readFileSync(path.join(root, "base.imljson"), "utf8"));
const connections = load("connections");
const webhooks = load("webhooks");
const modules = load("modules");
const rpcs = load("rpcs");

/** The value of a {{...}} expression in a context, or undefined to leave the key out. */
function evaluate(expression, context) {
  const encoded = /^encodeURL\(([^)]+)\)$/.exec(expression.trim());
  // fill() encodes what goes into a URL, as encodeURL does.
  if (encoded) return evaluate(encoded[1], context);
  if (
    expression.includes("statusCode") &&
    /^[\s0-9<>=|&!]+$/.test(expression.replaceAll("statusCode", ""))
  ) {
    // Our own files' comparisons of the status, nothing else.
    return new Function("statusCode", `return (${expression});`)(context.statusCode);
  }
  const ifempty = /^ifempty\(([^,]+),\s*([^)]+)\)$/.exec(expression.trim());
  if (ifempty) {
    const value = evaluate(ifempty[1], context);
    if (value !== undefined && value !== null && value !== "") return value;
    const fallback = ifempty[2].trim();
    if (fallback === "undefined") return undefined;
    return /^\d+$/.test(fallback) ? Number(fallback) : fallback.replace(/^'|'$/g, "");
  }
  return expression
    .trim()
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), context);
}

function fill(template, context) {
  if (typeof template === "string") {
    const whole = /^\{\{(.+)\}\}$/.exec(template);
    if (whole) return evaluate(whole[1], context);
    return template.replace(/\{\{(.+?)\}\}/g, (_, expression) =>
      encodeURIComponent(String(evaluate(expression, context) ?? ""))
    );
  }
  if (Array.isArray(template)) return template.map((item) => fill(item, context));
  if (template && typeof template === "object") {
    const out = {};
    for (const [key, value] of Object.entries(template)) {
      const filled = fill(value, context);
      if (filled !== undefined) out[key] = filled;
    }
    return out;
  }
  return template;
}

const BASE_URL = (process.env.WHK_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

/** Runs a communication block as Make would: base URL and headers, then the call. */
async function run(communication, context) {
  const spec = fill(communication, context);
  const url = spec.url.startsWith("http")
    ? spec.url.replace("https://webhooks.cc", BASE_URL)
    : `${BASE_URL}/api${spec.url}`;
  const query = spec.qs ? `?${new URLSearchParams(spec.qs)}` : "";
  const headers = { ...fill(base.headers, context), ...(spec.headers || {}) };
  const response = await fetch(`${url}${query}`, {
    method: spec.method || "GET",
    headers: { ...headers, ...(spec.body ? { "content-type": "application/json" } : {}) },
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("the Make app definitions", () => {
  it("are JSON whose references all resolve", () => {
    const names = (set) => Object.values(set).map((item) => item.name);
    for (const module of Object.values(modules)) {
      expect(names(connections)).toContain(module.connection);
      if (module.webhook) expect(names(webhooks)).toContain(module.webhook);
      for (const field of [...(module.expect || []), ...(module.parameters || [])]) {
        if (typeof field.options === "string" && field.options.startsWith("rpc://")) {
          expect(names(rpcs)).toContain(field.options.slice("rpc://".length));
        }
      }
    }
    for (const hook of Object.values(webhooks)) {
      expect(names(connections)).toContain(hook.connection);
    }
    expect(Object.keys(modules).sort()).toEqual([
      "create-endpoint.imljson",
      "find-emails.imljson",
      "send-test-email.imljson",
      "watch-emails.imljson",
    ]);
  });
});

// Against the running web app.
function devEnv() {
  try {
    const text = readFileSync(path.join(root, "../../apps/web/.env.local"), "utf8");
    return Object.fromEntries(
      text
        .split("\n")
        .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^"|"$/g, "")])
    );
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
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  try {
    running = (await fetch(`${BASE_URL}/api/health`)).ok && !!SUPABASE_URL && !!SERVICE_KEY;
  } catch {
    running = false;
  }
  if (!running) return;
  const user = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: `test-make-${Date.now()}@webhooks-test.local`,
      password: randomBytes(12).toString("hex"),
      email_confirm: true,
    }),
  });
  userId = user.id;
  apiKey = `whcc_${randomBytes(24).toString("hex")}`;
  await admin("/rest/v1/api_keys", {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      key_hash: createHash("sha256").update(apiKey).digest("hex"),
      key_prefix: apiKey.slice(0, 12),
      name: "Make test",
    }),
  });
}, 30_000);

afterAll(async () => {
  if (userId) await admin(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
});

describe("the Make app against the web app", () => {
  it("connects, creates an endpoint, sends a test email, watches and searches", async (context) => {
    if (!running) context.skip();
    const connection = { apiKey };
    const check = await run(connections["api-key.imljson"].communication, {
      parameters: connection,
    });
    expect(check.status).toBe(200);

    const created = await run(modules["create-endpoint.imljson"].communication, {
      connection,
      parameters: { name: "Make orders" },
    });
    expect(created.status).toBe(200);
    const slug = created.body.slug;

    const listed = await run(rpcs["list-endpoints.imljson"].communication, { connection });
    expect(listed.body.owned.map((item) => item.slug)).toContain(slug);

    const sent = await run(modules["send-test-email.imljson"].communication, {
      connection,
      parameters: { endpoint: slug },
    });
    expect(sent.status).toBe(200);

    // The instant trigger's webhook: attached, then detached.
    const hook = webhooks["new-email.imljson"];
    const attached = await run(hook.attach, {
      connection,
      parameters: { endpoint: slug },
      webhook: { url: "https://hook.eu1.make.com/abc123" },
    });
    expect(attached.status).toBe(201);
    const data = fill(hook.attach.response.data, {
      body: attached.body,
      parameters: { endpoint: slug },
    });
    expect(data).toEqual({ externalHookId: attached.body.id, endpoint: slug });
    const detached = await run(hook.detach, { connection, webhook: data });
    expect(detached.status).toBeLessThan(300);
    // Removed already (in the dashboard, say): detaching still succeeds.
    const again = await run(hook.detach, { connection, webhook: data });
    expect(again.status).toBe(404);
    expect(fill(hook.detach.response.valid, { statusCode: again.status })).toBe(true);
    expect(fill(hook.detach.response.valid, { statusCode: 500 })).toBe(false);

    const found = await run(modules["find-emails.imljson"].communication, {
      connection,
      parameters: { endpoint: slug, query: "test" },
    });
    expect(found.status).toBe(200);
    expect(Array.isArray(found.body)).toBe(true);
  }, 60_000);
});
