import { describe, expect, it } from "vitest";
import { sesHeaders, sesMessageId } from "./smtp-transport";

describe("sesHeaders", () => {
  it("sends nothing without a configuration set", () => {
    expect(sesHeaders({ kind: "welcome" }, undefined)).toEqual({});
  });

  it("names the configuration set and tags the kind", () => {
    expect(sesHeaders({ kind: "agent_code" }, "webhooks-cc-app")).toEqual({
      "X-SES-CONFIGURATION-SET": "webhooks-cc-app",
      "X-SES-MESSAGE-TAGS": "kind=agent_code",
    });
  });

  it("drops characters SES refuses in a tag value", () => {
    expect(sesHeaders({ kind: "a b,c=d;e" }, "set")["X-SES-MESSAGE-TAGS"]).toBe("kind=abcde");
    expect(sesHeaders({ kind: "  " }, "set")["X-SES-MESSAGE-TAGS"]).toBe("kind=unknown");
  });
});

describe("sesMessageId", () => {
  it("reads the id from SES's reply to the message", () => {
    expect(
      sesMessageId(
        "250 Ok 0107019a6d1f2b3c-4d5e6f70-1234-4abc-9def-0123456789ab-000000",
        "<x@local>"
      )
    ).toBe("0107019a6d1f2b3c-4d5e6f70-1234-4abc-9def-0123456789ab-000000");
  });

  it("falls back to the generated Message-ID for other servers", () => {
    expect(sesMessageId("250 2.0.0 Ok: queued as 4ABC", "<x@local>")).toBe("<x@local>");
    expect(sesMessageId(undefined, "<x@local>")).toBe("<x@local>");
  });
});
