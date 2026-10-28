/**
 * The agent credential file: its rules as conformance vectors for every port
 * (conformance/agent-credentials.json, rewritten with
 * `pnpm --filter @webhooks-cc/sdk exec vitest run agent-credentials -u`),
 * and the store's file handling.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCredentialStore,
  applyWrite,
  normalizeIssuer,
  readSlots,
  resolveCredentialsPath,
  usableToken,
  type CredentialSlot,
  type CredentialWrite,
} from "../agent-credentials";

const NOW = "2026-10-28T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ISSUER = "https://webhooks.cc";

const CLAIMED: CredentialSlot = {
  registration_id: "6f1c2d4e-8a1b-4c3d-9e2f-0a1b2c3d4e5f",
  identity_assertion: "eyJhbGciOiJFUzI1NiJ9.claimed.signature",
  assertion_expires: "2027-01-26T12:00:00.000Z",
  scope: "webhooks:read webhooks:write",
  email: "dev@example.com",
  client_name: "webhooks-cc-mcp",
  saved_at: "2026-10-28T11:00:00.000Z",
  access_token: "whcc_claimedtoken",
  access_token_expires: "2026-10-28T12:30:00.000Z",
};

const SANDBOX: CredentialSlot = {
  registration_id: "0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a",
  identity_assertion: "eyJhbGciOiJFUzI1NiJ9.sandbox.signature",
  assertion_expires: "2026-10-29T11:00:00.000Z",
  client_name: "whk-cli",
  saved_at: "2026-10-28T11:00:00.000Z",
};

const EXPIRED: CredentialSlot = {
  ...SANDBOX,
  registration_id: "11111111-2222-4333-8444-555555555555",
  assertion_expires: "2026-10-28T11:00:00.000Z",
};

function v1(issuers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { version: 1, issuers, ...extra };
}

const PATH_CASES = [
  { name: "linux default", platform: "linux", home: "/home/ada", env: {} },
  {
    name: "linux XDG_CONFIG_HOME",
    platform: "linux",
    home: "/home/ada",
    env: { XDG_CONFIG_HOME: "/xdg" },
  },
  {
    name: "linux XDG_CONFIG_HOME with a trailing slash",
    platform: "linux",
    home: "/home/ada",
    env: { XDG_CONFIG_HOME: "/xdg/" },
  },
  {
    name: "linux relative XDG_CONFIG_HOME is ignored",
    platform: "linux",
    home: "/home/ada",
    env: { XDG_CONFIG_HOME: "relative/config" },
  },
  {
    name: "linux empty XDG_CONFIG_HOME is ignored",
    platform: "linux",
    home: "/home/ada",
    env: { XDG_CONFIG_HOME: "" },
  },
  {
    name: "freebsd follows the XDG rules",
    platform: "freebsd",
    home: "/home/ada",
    env: { XDG_CONFIG_HOME: "/xdg" },
  },
  {
    name: "macOS ignores XDG_CONFIG_HOME",
    platform: "darwin",
    home: "/Users/ada",
    env: { XDG_CONFIG_HOME: "/xdg" },
  },
  {
    name: "windows APPDATA",
    platform: "win32",
    home: "C:\\Users\\ada",
    env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
  },
  {
    name: "windows without APPDATA",
    platform: "win32",
    home: "C:\\Users\\ada",
    env: {},
  },
  {
    name: "WHK_AGENT_FILE wins",
    platform: "linux",
    home: "/home/ada",
    env: { WHK_AGENT_FILE: "/run/agent/creds.json", XDG_CONFIG_HOME: "/xdg" },
  },
  {
    name: "empty WHK_AGENT_FILE is ignored",
    platform: "darwin",
    home: "/Users/ada",
    env: { WHK_AGENT_FILE: "" },
  },
  {
    name: "WHK_AGENT_FILE without a home",
    platform: "linux",
    home: null,
    env: { WHK_AGENT_FILE: "/run/agent/creds.json" },
  },
  { name: "no home", platform: "linux", home: null, env: {} },
  {
    name: "no home but an absolute XDG_CONFIG_HOME",
    platform: "linux",
    home: null,
    env: { XDG_CONFIG_HOME: "/xdg" },
  },
  { name: "windows with neither APPDATA nor a home", platform: "win32", home: null, env: {} },
];

const ISSUER_CASES = [
  "https://webhooks.cc",
  "https://webhooks.cc/",
  "https://WebHooks.CC///",
  "HTTP://LocalHost:3000",
  "http://127.0.0.1:3000/",
  "https://example.com/Base/Path/",
];

type ReadCase = { name: string; issuer?: string; file?: unknown; fileText?: string };

const READ_CASES: ReadCase[] = [
  { name: "no file" },
  {
    name: "both slots live, claimed token cached",
    file: v1({ [ISSUER]: { claimed: CLAIMED, sandbox: SANDBOX } }),
  },
  {
    name: "the issuer given with a trailing slash and capitals",
    issuer: "https://WebHooks.cc/",
    file: v1({ [ISSUER]: { claimed: CLAIMED } }),
  },
  { name: "another issuer only", file: v1({ "http://localhost:3000": { claimed: CLAIMED } }) },
  {
    name: "claimed expires in 30 seconds",
    file: v1({
      [ISSUER]: { claimed: { ...CLAIMED, assertion_expires: "2026-10-28T12:00:30.000Z" } },
    }),
  },
  {
    name: "claimed expires in 61 seconds",
    file: v1({
      [ISSUER]: { claimed: { ...CLAIMED, assertion_expires: "2026-10-28T12:01:01.000Z" } },
    }),
  },
  { name: "expired sandbox", file: v1({ [ISSUER]: { sandbox: EXPIRED } }) },
  {
    name: "claimed without identity_assertion",
    file: v1({ [ISSUER]: { claimed: { ...CLAIMED, identity_assertion: undefined } } }),
  },
  {
    name: "claimed with an empty registration_id",
    file: v1({ [ISSUER]: { claimed: { ...CLAIMED, registration_id: "" } } }),
  },
  {
    name: "numeric registration_id",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, registration_id: 42 } } }),
  },
  {
    name: "assertion_expires is not a timestamp",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "tomorrow" } } }),
  },
  {
    name: "assertion_expires as a date without a time",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-30" } } }),
  },
  {
    name: "assertion_expires with an offset and no fraction",
    file: v1({
      [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-29T13:00:00+02:00" } },
    }),
  },
  {
    name: "assertion_expires with microseconds",
    file: v1({
      [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-29T11:00:00.123456Z" } },
    }),
  },
  {
    name: "February 30 is not a date",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2027-02-30T00:00:00Z" } } }),
  },
  {
    name: "hour 24 is not a time",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-30T24:00:00Z" } } }),
  },
  {
    name: "February 29 of a leap year",
    file: v1({ [ISSUER]: { claimed: { ...CLAIMED, assertion_expires: "2028-02-29T12:00:00Z" } } }),
  },
  {
    name: "lowercase t and z are not accepted",
    file: v1({ [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-29t11:00:00z" } } }),
  },
  {
    name: "offset that puts the expiry in the past",
    file: v1({
      [ISSUER]: { sandbox: { ...SANDBOX, assertion_expires: "2026-10-28T13:00:00+02:00" } },
    }),
  },
  {
    name: "cached token without the whcc_ prefix",
    file: v1({ [ISSUER]: { claimed: { ...CLAIMED, access_token: "abc" } } }),
  },
  {
    name: "cached token expires in 30 seconds",
    file: v1({
      [ISSUER]: { claimed: { ...CLAIMED, access_token_expires: "2026-10-28T12:00:30.000Z" } },
    }),
  },
  {
    name: "cached token without an expiry",
    file: v1({ [ISSUER]: { claimed: { ...CLAIMED, access_token_expires: undefined } } }),
  },
  {
    name: "sandbox with a cached token",
    file: v1({
      [ISSUER]: {
        sandbox: {
          ...SANDBOX,
          access_token: "whcc_sandbox",
          access_token_expires: "2026-10-28T12:59:00.000Z",
        },
      },
    }),
  },
  { name: "version 2", file: { version: 2, issuers: { [ISSUER]: { claimed: CLAIMED } } } },
  {
    name: "version as a string",
    file: { version: "1", issuers: { [ISSUER]: { claimed: CLAIMED } } },
  },
  { name: "no version", file: { issuers: { [ISSUER]: { claimed: CLAIMED } } } },
  { name: "issuers is an array", file: { version: 1, issuers: [CLAIMED] } },
  { name: "top-level array", file: [CLAIMED] },
  { name: "not JSON", fileText: "{ this is not json" },
  { name: "empty file", fileText: "" },
  {
    name: "unknown keys are ignored",
    file: v1(
      { [ISSUER]: { claimed: { ...CLAIMED, future: true }, future_slot: { x: 1 } } },
      { comment: "hi" }
    ),
  },
];

type WriteCase = { name: string; issuer?: string; before: unknown; op: CredentialWrite };

const WRITE_CASES: WriteCase[] = [
  { name: "first write creates the file", before: null, op: { set: "sandbox", slot: SANDBOX } },
  {
    name: "set claimed next to a sandbox",
    before: v1({ [ISSUER]: { sandbox: SANDBOX } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "replace a slot",
    before: v1({ [ISSUER]: { claimed: { ...CLAIMED, access_token: "whcc_old" } } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "remove one slot keeps the other",
    before: v1({ [ISSUER]: { claimed: CLAIMED, sandbox: SANDBOX } }),
    op: { remove: "claimed" },
  },
  {
    name: "removing the last slot deletes the file",
    before: v1({ [ISSUER]: { claimed: CLAIMED } }),
    op: { remove: "claimed" },
  },
  {
    name: "removing a missing slot when nothing else is left deletes the file",
    before: null,
    op: { remove: "sandbox" },
  },
  {
    name: "other issuers are kept",
    before: v1({ "http://localhost:3000": { sandbox: SANDBOX } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "the issuer key is normalised",
    issuer: "https://WebHooks.cc/",
    before: v1({ [ISSUER]: { sandbox: SANDBOX } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "expired slots of every issuer are dropped, and issuers left empty",
    before: v1({
      [ISSUER]: { sandbox: EXPIRED },
      "http://localhost:3000": { claimed: EXPIRED },
    }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "malformed slots are dropped",
    before: v1({ [ISSUER]: { sandbox: { registration_id: "x" } } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "unknown keys at the top and in issuers are kept",
    before: v1(
      {
        [ISSUER]: { sandbox: SANDBOX, future_slot: { x: 1 } },
        "https://other.example": { future_slot: [1] },
      },
      { comment: "kept" }
    ),
    op: { remove: "sandbox" },
  },
  {
    name: "issuer values that are not objects are dropped",
    before: v1({ "https://other.example": "junk", [ISSUER]: { sandbox: SANDBOX } }),
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "a newer version is left alone",
    before: { version: 2, issuers: {} },
    op: { set: "claimed", slot: CLAIMED },
  },
  {
    name: "a file without a version is replaced",
    before: { issuers: { [ISSUER]: { claimed: CLAIMED } } },
    op: { set: "sandbox", slot: SANDBOX },
  },
  {
    name: "a top-level array is replaced",
    before: [1, 2],
    op: { set: "sandbox", slot: SANDBOX },
  },
  {
    name: "setting an expired slot leaves nothing to write",
    before: null,
    op: { set: "sandbox", slot: EXPIRED },
  },
];

function parseFileText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function buildVectors() {
  return {
    version: 1,
    generatedBy: "packages/sdk/src/__tests__/agent-credentials.test.ts",
    description:
      'The agent credential file (agent-credentials.md). paths: resolve the file for platform (process.platform names; anything but win32 and darwin follows the XDG rules), home and env; compare with backslashes replaced by slashes; null means there is no file. issuers: normalise a base URL into its key. reads: given the file (file is the parsed JSON, fileText its raw text; neither means no file) and the clock at now, report which slots for issuer are live and whether each live slot has a usable cached access token. writes: apply op (set a slot to exactly op.slot, or remove one) for issuer to the file before (null: no file) at now; expected is the JSON written (compare structurally), null when the file is deleted, or "unchanged" when nothing may be written.',
    paths: PATH_CASES.map((c) => ({
      ...c,
      expected: resolveCredentialsPath(c.platform, c.home, c.env)?.split("\\").join("/") ?? null,
    })),
    issuers: ISSUER_CASES.map((input) => ({ input, expected: normalizeIssuer(input) })),
    reads: READ_CASES.map((c) => {
      const issuer = c.issuer ?? ISSUER;
      const parsed =
        c.fileText !== undefined ? parseFileText(c.fileText) : ((c.file as unknown) ?? null);
      const slots = readSlots(parsed, issuer, NOW_MS);
      // JSON.stringify drops the undefined fields the cases use to leave keys out.
      const file = c.file === undefined ? {} : { file: JSON.parse(JSON.stringify(c.file)) };
      return {
        name: c.name,
        now: NOW,
        issuer,
        ...file,
        ...(c.fileText !== undefined ? { fileText: c.fileText } : {}),
        expected: {
          claimed: slots.claimed !== null,
          sandbox: slots.sandbox !== null,
          claimedToken: slots.claimed !== null && usableToken(slots.claimed, NOW_MS) !== null,
          sandboxToken: slots.sandbox !== null && usableToken(slots.sandbox, NOW_MS) !== null,
        },
      };
    }),
    writes: WRITE_CASES.map((c) => {
      const issuer = c.issuer ?? ISSUER;
      return {
        name: c.name,
        now: NOW,
        issuer,
        before: c.before,
        op: c.op,
        expected: applyWrite(c.before, issuer, c.op, NOW_MS),
      };
    }),
  };
}

describe("agent credential vectors", () => {
  it("agent-credentials.json", async () => {
    const vectors = buildVectors();
    // A few anchors, so a rule change cannot rewrite the file unnoticed.
    expect(vectors.paths[0].expected).toBe("/home/ada/.config/whk/agent.json");
    expect(vectors.paths.find((p) => p.name === "windows without APPDATA")?.expected).toBe(
      "C:/Users/ada/AppData/Roaming/whk/agent.json"
    );
    expect(vectors.issuers.map((i) => i.expected)).toContain("http://localhost:3000");
    expect(vectors.reads[1].expected).toEqual({
      claimed: true,
      sandbox: true,
      claimedToken: true,
      sandboxToken: false,
    });
    expect(vectors.writes.find((w) => w.name.startsWith("a newer"))?.expected).toBe("unchanged");
    await expect(`${JSON.stringify(vectors, null, 2)}\n`).toMatchFileSnapshot(
      "../../conformance/agent-credentials.json"
    );
  });
});

describe("AgentCredentialStore", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "whk-agent-"));
    path = join(dir, "nested", "agent.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file with mode 0600 in a 0700 directory and reads it back", () => {
    const store = new AgentCredentialStore(path);
    const slot = { ...CLAIMED, assertion_expires: new Date(Date.now() + 86_400_000).toISOString() };
    store.save(ISSUER, "claimed", slot);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(store.load(`${ISSUER}/`).claimed).toEqual(slot);
    expect(readdirSync(join(dir, "nested"))).toEqual(["agent.json"]);
  });

  it("deletes the file when the last slot goes", () => {
    const store = new AgentCredentialStore(path);
    const slot = { ...SANDBOX, assertion_expires: new Date(Date.now() + 86_400_000).toISOString() };
    store.save(ISSUER, "sandbox", slot);
    store.remove(ISSUER, "sandbox");
    expect(() => statSync(path)).toThrow();
  });

  it("reads a broken file as empty and replaces it on the next write", () => {
    const store = new AgentCredentialStore(join(dir, "agent.json"));
    writeFileSync(join(dir, "agent.json"), "{ broken");
    expect(store.load(ISSUER)).toEqual({ claimed: null, sandbox: null });
    const slot = { ...SANDBOX, assertion_expires: new Date(Date.now() + 86_400_000).toISOString() };
    store.save(ISSUER, "sandbox", slot);
    expect(JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")).version).toBe(1);
  });

  it("never writes over a newer format", () => {
    const file = join(dir, "agent.json");
    writeFileSync(file, '{"version":2}');
    new AgentCredentialStore(file).save(ISSUER, "claimed", CLAIMED);
    expect(readFileSync(file, "utf8")).toBe('{"version":2}');
  });

  it("removes or refreshes a slot only while it holds the same registration", () => {
    const store = new AgentCredentialStore(path);
    const live = new Date(Date.now() + 86_400_000).toISOString();
    const r1 = { ...CLAIMED, registration_id: "r1", assertion_expires: live };
    const r2 = { ...CLAIMED, registration_id: "r2", assertion_expires: live };
    store.save(ISSUER, "claimed", r2);
    // A process still holding r1 refreshes its token, then is refused.
    store.save(ISSUER, "claimed", { ...r1, access_token: "whcc_old" }, { ifRegistration: "r1" });
    store.remove(ISSUER, "claimed", { ifRegistration: "r1" });
    expect(store.load(ISSUER).claimed?.registration_id).toBe("r2");
    store.remove(ISSUER, "claimed", { ifRegistration: "r2" });
    expect(store.load(ISSUER).claimed).toBeNull();
    // Nothing to refresh once another process removed the slot.
    store.save(
      ISSUER,
      "sandbox",
      { ...SANDBOX, assertion_expires: live },
      { ifRegistration: SANDBOX.registration_id }
    );
    expect(store.load(ISSUER).sandbox).toBeNull();
  });

  it("resolves to no store when turned off", () => {
    expect(AgentCredentialStore.resolve(false)).toBeNull();
    expect(AgentCredentialStore.resolve(path)?.path).toBe(path);
  });
});
