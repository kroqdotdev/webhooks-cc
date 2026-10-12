import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@statoss/sdk";

const sdk = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn() }));
vi.mock("@statoss/sdk", () => sdk);

import {
  isNoise,
  prepareBrowserEvent,
  reportBoundaryError,
  startBrowserObservability,
  withoutQuery,
} from "./observability-browser";

const ours = "https://webhooks.cc/_next/static/chunks/app-1a2b.js";

function exception(type: string, value: string, files: string[] = [ours]): Event {
  return {
    exception: {
      values: [{ type, value, stacktrace: { frames: files.map((abs_path) => ({ abs_path })) } }],
    },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("isNoise", () => {
  it("keeps an error thrown by our bundles", () => {
    expect(isNoise(exception("TypeError", "x is undefined"))).toBe(false);
  });

  it("drops network, browser and stale-tab failures", () => {
    for (const [type, value] of [
      ["TypeError", "Failed to fetch"],
      ["TypeError", "Load failed"],
      ["Error", "ResizeObserver loop completed with undelivered notifications."],
      ["Error", "Script error."],
      ["ChunkLoadError", "Loading chunk 123 failed."],
      ["AbortError", "The user aborted a request."],
    ]) {
      expect(isNoise(exception(type, value))).toBe(true);
    }
  });

  it("drops errors whose frames are all someone else's", () => {
    expect(isNoise(exception("TypeError", "boom", ["chrome-extension://abc/content.js"]))).toBe(
      true
    );
    expect(isNoise(exception("TypeError", "boom", ["https://cdn.example.com/widget.js"]))).toBe(
      true
    );
    expect(isNoise(exception("TypeError", "boom", [ours, "moz-extension://x/a.js"]))).toBe(true);
  });

  it("keeps an error without frames", () => {
    expect(isNoise(exception("Error", "Non-Error promise rejection", []))).toBe(false);
  });
});

describe("prepareBrowserEvent", () => {
  it("strips query strings and fragments, and email addresses", () => {
    const event: Event = {
      ...exception("TypeError", "no user someone@example.com"),
      request: {
        url: "https://webhooks.cc/dashboard?endpoint=abc123#top",
        query_string: "endpoint=abc123",
        headers: { "User-Agent": "Firefox" },
      },
      breadcrumbs: {
        values: [
          { category: "fetch", data: { method: "GET", url: "/api/go/endpoint/abc?x=1" } },
          { category: "navigation", data: { from: "/go?slug=abc", to: "/dashboard#x" } },
          { category: "console", message: "sent to a@b.example" },
        ],
      },
    };
    expect(prepareBrowserEvent(event)).toEqual({
      exception: event.exception && {
        values: [{ ...event.exception.values[0], value: "no user [email]" }],
      },
      request: { url: "https://webhooks.cc/dashboard", headers: { "User-Agent": "Firefox" } },
      breadcrumbs: {
        values: [
          { category: "fetch", data: { method: "GET", url: "/api/go/endpoint/abc" } },
          { category: "navigation", data: { from: "/go", to: "/dashboard" } },
          { category: "console", message: "sent to [email]" },
        ],
      },
    });
  });

  it("drops noise", () => {
    expect(prepareBrowserEvent(exception("TypeError", "Failed to fetch"))).toBeNull();
  });

  it("withoutQuery leaves a plain URL alone", () => {
    expect(withoutQuery("/dashboard")).toBe("/dashboard");
    expect(withoutQuery("/a#b?c")).toBe("/a");
  });
});

describe("startBrowserObservability", () => {
  it("does nothing without a DSN", () => {
    vi.stubEnv("NEXT_PUBLIC_STATOSS_DSN", "");
    expect(startBrowserObservability()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("starts with the release and the filter", () => {
    vi.stubEnv("NEXT_PUBLIC_STATOSS_DSN", "https://key@ingest.example/8");
    vi.stubEnv("NEXT_PUBLIC_STATOSS_RELEASE", "webhooks-web@1.0.0");
    expect(startBrowserObservability()).toBe(true);
    expect(sdk.init).toHaveBeenCalledWith({
      dsn: "https://key@ingest.example/8",
      environment: "test",
      release: "webhooks-web@1.0.0",
      beforeSend: expect.any(Function),
    });
  });
});

describe("reportBoundaryError", () => {
  it("tags the boundary and the digest", () => {
    const error = Object.assign(new Error("render failed"), { digest: "42" });
    reportBoundaryError(error, "global");
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { boundary: "global", digest: "42" },
    });
  });
});
