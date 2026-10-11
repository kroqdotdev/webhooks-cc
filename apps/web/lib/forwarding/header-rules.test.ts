import { describe, expect, it } from "vitest";
import { headerNameIssue, headerValueAllowed, refusedHeaderName } from "./header-rules";

describe("headerNameIssue", () => {
  it("accepts ordinary names", () => {
    expect(headerNameIssue("Authorization")).toBeNull();
    expect(headerNameIssue("X-Environment")).toBeNull();
  });

  it("refuses names that are not tokens", () => {
    expect(headerNameIssue("")).toBe("invalid");
    expect(headerNameIssue("X Auth Token")).toBe("invalid");
    expect(headerNameIssue("a".repeat(65))).toBe("invalid");
  });

  it("refuses what the delivery or the proxy sets", () => {
    for (const name of ["Host", "content-length", "Transfer-Encoding", "Proxy-Authorization"]) {
      expect(headerNameIssue(name)).toBe("delivery");
    }
    expect(headerNameIssue("X-Target-Url")).toBe("delivery");
    // The notify proxy drops cf-* on the way out, so they could never arrive.
    expect(headerNameIssue("CF-Access-Client-Id")).toBe("delivery");
  });

  it("refuses the signature and metadata prefixes", () => {
    expect(headerNameIssue("webhook-signature")).toBe("webhook");
    expect(headerNameIssue("Webhooks-CC-Endpoint")).toBe("webhooks-cc");
  });

  it("keeps the API's messages", () => {
    expect(refusedHeaderName("Host")).toBe(
      "Host is set by the request itself and cannot be added."
    );
    expect(refusedHeaderName("x-auth")).toBe("x-auth is reserved by webhooks.cc.");
    expect(refusedHeaderName("CF-Access-Client-Id")).toBe(
      "CF-Access-Client-Id is set by Cloudflare on the way out and cannot be added."
    );
    expect(refusedHeaderName("Authorization")).toBeNull();
  });
});

describe("headerValueAllowed", () => {
  it("wants one line within the limit", () => {
    expect(headerValueAllowed("Bearer abc")).toBe(true);
    expect(headerValueAllowed("a\nb")).toBe(false);
    expect(headerValueAllowed("x".repeat(1025))).toBe(false);
  });
});
