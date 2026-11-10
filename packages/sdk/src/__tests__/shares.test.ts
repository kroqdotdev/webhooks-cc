import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhooksCC } from "../client";
import {
  share,
  WHK_INSTALL_COMMAND,
  WHK_INSTALL_WINDOWS,
  whkInstallHint,
  type ShareEvent,
} from "../share";
import { WebhooksCCError } from "../errors";

const API_KEY = "whcc_testkey123";
const BASE_URL = "https://test.webhooks.cc";

function client() {
  return new WebhooksCC({ apiKey: API_KEY, baseUrl: BASE_URL });
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("shares and names", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists shares, narrowed by state", async () => {
    const body = { shares: [], usage: { month: "2026-11" }, limits: { plan: "pro" } };
    const fetchMock = mockFetch(body);
    globalThis.fetch = fetchMock;
    expect(await client().shares.list()).toEqual(body);
    await client().shares.list({ state: "live" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/shares`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE_URL}/api/shares?state=live`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    await expect(client().shares.list({ state: "all" as "live" })).rejects.toThrow("state");
  });

  it("stops a share and reads its visitor requests", async () => {
    const fetchMock = mockFetch({ ok: true });
    globalThis.fetch = fetchMock;
    await client().shares.stop("e1d30211-a47f-4f23-a502-e0931e462d2d");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE_URL}/api/shares/e1d30211-a47f-4f23-a502-e0931e462d2d/stop`
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");

    const visits = { available: true, requests: [{ method: "GET", path: "/", status: 200 }] };
    globalThis.fetch = mockFetch(visits);
    expect(await client().shares.requests("s1")).toEqual(visits);
    await expect(client().shares.stop("../x")).rejects.toThrow("Invalid id");
  });

  it("reserves, releases and protects names", async () => {
    const reserved = { name: "acme-demo", url: "https://acme-demo.sharehooks.cc", mine: true };
    const fetchMock = mockFetch({ name: reserved }, 201);
    globalThis.fetch = fetchMock;
    expect(await client().names.reserve("acme-demo", { team: "t1" })).toEqual(reserved);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/tunnel-names`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "acme-demo", team: "t1" });

    const ok = mockFetch({ ok: true, password: true });
    globalThis.fetch = ok;
    await client().names.setPassword("acme-demo", "correct-horse");
    await client().names.clearPassword("acme-demo");
    await client().names.release("acme-demo");
    expect(ok.mock.calls.map((c) => [c[1].method, c[0]])).toEqual([
      ["PUT", `${BASE_URL}/api/tunnel-names/acme-demo/password`],
      ["DELETE", `${BASE_URL}/api/tunnel-names/acme-demo/password`],
      ["DELETE", `${BASE_URL}/api/tunnel-names/acme-demo`],
    ]);
    expect(JSON.parse(ok.mock.calls[0][1].body)).toEqual({ password: "correct-horse" });
    await expect(client().names.setPassword("acme-demo", "short")).rejects.toThrow("8 to 200");
  });

  it("describes the share and name operations", () => {
    const description = client().describe();
    expect(Object.keys(description.shares)).toEqual(["list", "stop", "requests", "start"]);
    expect(Object.keys(description.names)).toEqual([
      "list",
      "reserve",
      "release",
      "setPassword",
      "clearPassword",
    ]);
  });
});

/**
 * A fake whk: records its arguments and environment, then prints what the
 * scenario in FAKE_WHK_SCENARIO says, as `whk share --json` would.
 */
const FAKE_WHK = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_WHK_LOG, JSON.stringify({
  args: process.argv.slice(2),
  password: process.env.WHK_SHARE_PASSWORD ?? null,
  apiKey: process.env.WHK_API_KEY ?? null,
  apiUrl: process.env.WHK_API_URL ?? null,
  auth: process.env.WHK_AUTH ?? null,
  agentFile: process.env.WHK_AGENT_FILE ?? null,
}));
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const scenario = process.env.FAKE_WHK_SCENARIO;
if (scenario === "refused") {
  out({ event: "error", message: "Free allows 1 live share at a time. Stop one first." });
  process.exit(1);
}
if (scenario === "old") {
  process.stderr.write("error: unrecognized subcommand 'share'\\n");
  process.exit(2);
}
out({ event: "live", url: "https://calm-river-7f2a-free.sharehooks.cc", name: "calm-river-7f2a-free", expiresAt: "2026-11-10T20:00:00Z", notice: true, password: false });
out({ event: "request", method: "GET", path: "/", status: 200, ms: 4 });
process.on("SIGINT", () => { out({ event: "stopped", reason: "you stopped it on this computer" }); process.exit(0); });
// --until-stdin-closes: what share().stop() relies on, on every platform.
process.stdin.on("end", () => { out({ event: "stopped", reason: "the program that started it ended" }); process.exit(0); });
process.stdin.resume();
setInterval(() => {}, 1000);
`;

describe("share()", () => {
  let dir: string;
  let bin: string;
  let log: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "whk-share-"));
    bin = join(dir, "whk");
    log = join(dir, "log.json");
    writeFileSync(bin, FAKE_WHK);
    chmodSync(bin, 0o755);
    process.env.FAKE_WHK_LOG = log;
  });

  afterEach(() => {
    delete process.env.FAKE_WHK_SCENARIO;
  });

  it("resolves with the link, reports requests, and stops", async () => {
    const events: ShareEvent[] = [];
    const requests: string[] = [];
    const live = await share({
      port: 3000,
      name: "acme-demo",
      password: "correct-horse",
      whkPath: bin,
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      onEvent: (e) => events.push(e),
      onRequest: (r) => requests.push(`${r.method} ${r.path} ${r.status}`),
    });
    expect(live.url).toBe("https://calm-river-7f2a-free.sharehooks.cc");
    expect(live.notice).toBe(true);
    expect(live.expiresAt).toBe("2026-11-10T20:00:00Z");
    expect(live.port).toBe(3000);

    const seen = JSON.parse(readFileSync(log, "utf8"));
    expect(seen.args).toEqual([
      "share",
      "3000",
      "--json",
      "--until-stdin-closes",
      "--name",
      "acme-demo",
      "--password",
    ]);
    // The password goes through the environment, never the arguments.
    expect(seen.args.join(" ")).not.toContain("correct-horse");
    expect(seen.password).toBe("correct-horse");
    expect(seen.apiKey).toBe(API_KEY);
    expect(seen.apiUrl).toBe(BASE_URL);

    await vi.waitFor(() => expect(requests).toEqual(["GET / 200"]));
    const before = Date.now();
    await live.stop();
    // Closing stdin ends it at once: no wait for the signal fallback.
    expect(Date.now() - before).toBeLessThan(4000);
    expect((await live.closed).reason).toBe("you stopped it on this computer");
    expect(events.map((e) => e.event)).toEqual(["live", "request", "stopped"]);
  });

  it("shares as the agent connection when asked, never with a stray key", async () => {
    const previous = process.env.WHK_API_KEY;
    process.env.WHK_API_KEY = "whcc_from_the_environment";
    try {
      const live = await share({
        port: 3000,
        whkPath: bin,
        auth: "agent",
        agentFile: join(dir, "agent.json"),
      });
      const seen = JSON.parse(readFileSync(log, "utf8"));
      expect(seen.auth).toBe("agent");
      expect(seen.agentFile).toBe(join(dir, "agent.json"));
      expect(seen.apiKey).toBeNull();
      await live.stop();
    } finally {
      if (previous === undefined) delete process.env.WHK_API_KEY;
      else process.env.WHK_API_KEY = previous;
    }
  });

  it("refuses shares.start() for a client whk cannot share as", async () => {
    const tokenClient = new WebhooksCC({
      baseUrl: BASE_URL,
      getAccessToken: () => Promise.resolve("token"),
    });
    await expect(tokenClient.shares.start({ port: 3000, whkPath: bin })).rejects.toThrow(
      "WebhooksCC.connected()"
    );
  });

  it("gives install instructions for the platform", () => {
    expect(whkInstallHint("linux")).toBe(WHK_INSTALL_COMMAND);
    expect(whkInstallHint("darwin")).toBe(WHK_INSTALL_COMMAND);
    expect(whkInstallHint("win32")).toBe(WHK_INSTALL_WINDOWS);
    expect(WHK_INSTALL_WINDOWS).toContain("github.com/kroqdotdev/webhooks-cc/releases");
  });

  it("rejects with the CLI's words when the share is refused", async () => {
    process.env.FAKE_WHK_SCENARIO = "refused";
    await expect(share({ port: 3000, whkPath: bin })).rejects.toThrow(
      "Free allows 1 live share at a time"
    );
  });

  it("says to update a whk without share", async () => {
    process.env.FAKE_WHK_SCENARIO = "old";
    await expect(share({ port: 3000, whkPath: bin })).rejects.toThrow("whk update");
  });

  it("says how to install whk when it is missing", async () => {
    const error = await share({ port: 3000, whkPath: join(dir, "nope") }).catch((e) => e);
    expect(error).toBeInstanceOf(WebhooksCCError);
    expect(error.message).toContain(WHK_INSTALL_COMMAND);
  });

  it("refuses bad ports, names and passwords before running anything", async () => {
    await expect(share({ port: 0, whkPath: bin })).rejects.toThrow("not a port");
    await expect(share({ port: 70000, whkPath: bin })).rejects.toThrow("not a port");
    await expect(share({ port: 3000, name: "Acme Demo", whkPath: bin })).rejects.toThrow(
      "share name"
    );
    await expect(share({ port: 3000, password: "short", whkPath: bin })).rejects.toThrow(
      "8 to 200"
    );
  });
});
