import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@statoss/sdk", () => sdk);

import { APP_VERSION } from "./changelog";
import { redactEmails, redactEvent, redactText } from "./observability-redact";
import { startObservability } from "./observability-start";

const originals = {
  error: console.error,
  warn: console.warn,
  info: console.info,
  log: console.log,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const level of ["error", "warn", "info", "log"] as const) console[level] = vi.fn();
});

afterEach(() => {
  Object.assign(console, originals);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("startObservability", () => {
  it("does nothing without a DSN", () => {
    vi.stubEnv("STATOSS_DSN", "");
    expect(startObservability()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("starts the client with the release and without fetch breadcrumbs", () => {
    vi.stubEnv("STATOSS_DSN", "https://key@ingest.example/2");
    vi.stubEnv("STATOSS_ENVIRONMENT", "staging");
    vi.stubEnv("GIT_SHA", "0123456789abcdef0123");
    expect(startObservability()).toBe(true);
    expect(sdk.init).toHaveBeenCalledWith({
      dsn: "https://key@ingest.example/2",
      environment: "staging",
      release: `webhooks-web@${APP_VERSION}+0123456789ab`,
      logs: true,
      beforeSend: expect.any(Function),
      integrations: { fetch: false },
    });
  });

  it("sends console error, warn and info lines as log lines, and not console.log", () => {
    vi.stubEnv("STATOSS_DSN", "https://key@ingest.example/2");
    const shown = { error: console.error, info: console.info, log: console.log };
    startObservability();
    console.error("Failed to list endpoints:", { code: "57014" });
    console.info("[forwarding] alive claimed=%d", 3);
    console.log("[dev-email] to=someone");
    expect(shown.error).toHaveBeenCalledWith("Failed to list endpoints:", { code: "57014" });
    expect(sdk.logger.error).toHaveBeenCalledWith("Failed to list endpoints: { code: '57014' }");
    expect(sdk.logger.info).toHaveBeenCalledWith("[forwarding] alive claimed=3");
    expect(shown.log).toHaveBeenCalledWith("[dev-email] to=someone");
    expect(sdk.logger.info).toHaveBeenCalledTimes(1);
  });

  it("caps the lines a minute and says how many it kept back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv("STATOSS_DSN", "https://key@ingest.example/2");
    startObservability();
    for (let i = 0; i < 605; i++) console.warn("slow");
    expect(sdk.logger.warn).toHaveBeenCalledTimes(600);
    vi.setSystemTime(60_000);
    console.warn("slow");
    expect(sdk.logger.warn).toHaveBeenCalledWith("5 log lines were kept from StatOSS last minute");
    expect(sdk.logger.warn).toHaveBeenLastCalledWith("slow");
  });

  it("keeps audit rows out and replaces email addresses", () => {
    vi.stubEnv("STATOSS_DSN", "https://key@ingest.example/2");
    startObservability();
    console.info('[audit] {"action":"team.invite","metadata":{"invited_email":"a@b.example"}}');
    console.error("[audit] insert failed:", "timeout");
    console.error("duplicate key: Key (email)=(Someone.Else+x@mail.example.co.uk) exists");
    expect(sdk.logger.info).not.toHaveBeenCalled();
    expect(sdk.logger.error).toHaveBeenCalledWith("[audit] insert failed: timeout");
    expect(sdk.logger.error).toHaveBeenCalledWith("duplicate key: Key (email)=([email]) exists");
  });
});

describe("redaction", () => {
  it("replaces addresses in text and anywhere in an event", () => {
    expect(redactEmails("to a.b@c.example and x@y.io")).toBe("to [email] and [email]");
    expect(redactEmails("no address @ here, user@localhost")).toBe(
      "no address @ here, user@localhost"
    );
    const event = {
      message: "Failed: user@example.com",
      extra: { detail: { details: "Key (email)=(user@example.com)" } },
      breadcrumbs: [{ message: "sent to team@example.org" }],
    };
    expect(redactEvent(event)).toEqual({
      message: "Failed: [email]",
      extra: { detail: { details: "Key (email)=([email])" } },
      breadcrumbs: [{ message: "sent to [email]" }],
    });
  });

  it("drops URL queries and fragments from any text, and keeps the rest", () => {
    expect(redactText("Request to /go?token=secret failed")).toBe("Request to /go failed");
    expect(redactText("GET https://api.example.com/rest/v1/x?slug=eq.abc&select=* 500")).toBe(
      "GET https://api.example.com/rest/v1/x 500"
    );
    expect(redactText("at f (https://webhooks.cc/_next/a.js?dpl=1:3:4)")).toBe(
      "at f (https://webhooks.cc/_next/a.js)"
    );
    expect(redactText("plain text, no URL, 3 > 2")).toBe("plain text, no URL, 3 > 2");
    expect(redactText("GET https://webhooks.cc/s/AbCdEfGhIjKlMnOpQrStUv 500")).toBe(
      "GET https://webhooks.cc/s/[token] 500"
    );
    expect(
      redactEvent({ request: { headers: { Referer: "https://webhooks.cc/go?slug=abc" } } })
    ).toEqual({ request: { headers: { Referer: "https://webhooks.cc/go" } } });
    expect(redactEvent({ value: 'line one\nfrom /a?x=1 "quoted"' })).toEqual({
      value: 'line one\nfrom /a "quoted"',
    });
  });
});
