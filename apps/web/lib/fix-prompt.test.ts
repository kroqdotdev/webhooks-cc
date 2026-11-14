import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  deliveryErrorKind,
  isAgentRepo,
  parseAgentRepo,
  t3CodeLink,
} from "./fix-prompt";

const DELIVERY_ID = "6f1c2a4e-8b3d-4c5e-9f00-1a2b3c4d5e6f";
const REQUEST_ID = "0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5";

describe("buildFixPrompt", () => {
  it("names the status and the ids", () => {
    expect(
      buildFixPrompt({ id: DELIVERY_ID, requestId: REQUEST_ID, lastStatus: 500, lastError: null })
    ).toBe(
      `A webhooks.cc delivery failed with status 500. Using the webhooks.cc MCP server or \`whk\`, read delivery ${DELIVERY_ID} of request ${REQUEST_ID}, find why the handler failed, fix it in this repository, then redeliver and confirm it succeeds.`
    );
  });

  it("names the kind of network error, never the message", () => {
    const prompt = buildFixPrompt({
      id: DELIVERY_ID,
      requestId: REQUEST_ID,
      lastStatus: null,
      lastError: "No answer within 30 s.",
    });
    expect(prompt).toContain("failed with a timeout (no answer in time).");
    expect(prompt).not.toContain("30 s");
  });

  it("carries no customer data, whatever the delivery holds", () => {
    const secret = "acme-orders-x7q";
    // Every field a delivery row or the dashboard's copy of it has, filled with customer data.
    const delivery = {
      id: DELIVERY_ID,
      requestId: REQUEST_ID,
      lastStatus: null,
      lastError: `connect ECONNREFUSED https://${secret}.example.com/hooks?token=${secret} for jane@${secret}.example`,
      kind: "email",
      status: "failed",
      slug: secret,
      endpointSlug: secret,
      target: `${secret}.example.com/hooks`,
      format: "json",
      destination: { id: "d", name: `${secret} ERP`, url: `https://${secret}.example.com/hooks` },
      headers: { authorization: `Bearer ${secret}`, "x-customer": secret },
      body: JSON.stringify({ email: `jane@${secret}.example`, order: secret }),
      subject: `Order ${secret}`,
      from: `jane@${secret}.example`,
      attemptLog: [
        {
          attemptedAt: 1,
          status: null,
          durationMs: 1,
          error: secret,
          responseExcerpt: `<html>${secret}</html>`,
        },
      ],
    };
    const prompt = buildFixPrompt(delivery as never);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("a refused connection");
    for (const forbidden of [secret, "example.com", "@", "Bearer", "ECONNREFUSED", "ERP", "http"]) {
      expect(prompt).not.toContain(forbidden);
    }
    // Only fixed words, the two ids and a status number.
    const rest = prompt!.replace(DELIVERY_ID, "").replace(REQUEST_ID, "");
    expect(rest).toMatch(/^[A-Za-z .,`()]+$/);
  });

  it("refuses ids that are not ids, so nothing rides in their place", () => {
    expect(
      buildFixPrompt({ id: "acme-orders", requestId: REQUEST_ID, lastStatus: 500, lastError: null })
    ).toBeNull();
    expect(
      buildFixPrompt({
        id: DELIVERY_ID,
        requestId: "jane@example.com",
        lastStatus: 500,
        lastError: null,
      })
    ).toBeNull();
  });

  it("ignores a status that is not an HTTP status", () => {
    expect(
      buildFixPrompt({ id: DELIVERY_ID, requestId: REQUEST_ID, lastStatus: 0, lastError: "oops" })
    ).toContain("failed with an error before any answer.");
  });
});

describe("deliveryErrorKind", () => {
  it("reads the worker's wording", () => {
    expect(deliveryErrorKind("No answer within 30 s.")).toBe("timeout");
    expect(deliveryErrorKind("The connection was refused.")).toBe("connection_refused");
    expect(deliveryErrorKind("The connection was reset.")).toBe("connection_reset");
    expect(deliveryErrorKind("The host name could not be resolved.")).toBe("dns");
    expect(deliveryErrorKind("The host could not be reached.")).toBe("unreachable");
    expect(deliveryErrorKind("TLS certificate problem (CERT_HAS_EXPIRED).")).toBe("tls");
    expect(deliveryErrorKind("The URL must use https.")).toBe("url_refused");
    expect(deliveryErrorKind("Port 22 is not allowed.")).toBe("url_refused");
    expect(deliveryErrorKind("something else")).toBe("other");
    expect(deliveryErrorKind(null)).toBe("other");
  });
});

describe("agent repositories", () => {
  it("accepts GitHub owner/name", () => {
    for (const ok of ["acme/api", "Acme-Inc/web.app", "a/b", "acme/my_repo-2", "acme/.github"]) {
      expect(isAgentRepo(ok)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "acme",
      "acme/",
      "/api",
      "-acme/api",
      "acme/api/extra",
      "acme/..",
      "acme/.",
      "ac me/api",
      "acme/api?x=1",
      "https://github.com/acme/api",
      `${"a".repeat(40)}/api`,
      `acme/${"a".repeat(101)}`,
      "acme_inc/api",
      42,
      null,
    ]) {
      expect(isAgentRepo(bad)).toBe(false);
    }
    expect(isAgentRepo(`${"a".repeat(39)}/${"b".repeat(100)}`)).toBe(true);
  });

  it("parses what a client sends", () => {
    expect(parseAgentRepo(null)).toEqual({ ok: true, value: null });
    expect(parseAgentRepo("")).toEqual({ ok: true, value: null });
    expect(parseAgentRepo("  acme/api.git ")).toEqual({ ok: true, value: "acme/api" });
    expect(parseAgentRepo("acme/api")).toEqual({ ok: true, value: "acme/api" });
    expect(parseAgentRepo("acme").ok).toBe(false);
    expect(parseAgentRepo(7).ok).toBe(false);
  });
});

describe("t3CodeLink", () => {
  const prompt = buildFixPrompt({
    id: DELIVERY_ID,
    requestId: REQUEST_ID,
    lastStatus: 502,
    lastError: null,
  })!;

  it("encodes the prompt and names the repository", () => {
    const link = t3CodeLink(prompt, "acme/api");
    expect(link.startsWith("https://app.t3.codes/new?prompt=")).toBe(true);
    expect(link).toContain("&repo=acme/api");
    expect(link).not.toContain(" ");
    expect(link).not.toContain("`");
    const params = new URL(link).searchParams;
    expect(params.get("prompt")).toBe(prompt);
    expect(params.get("repo")).toBe("acme/api");
  });

  it("leaves the repository out when there is none or it is not one", () => {
    expect(new URL(t3CodeLink(prompt)).searchParams.has("repo")).toBe(false);
    expect(new URL(t3CodeLink(prompt, null)).searchParams.has("repo")).toBe(false);
    expect(new URL(t3CodeLink(prompt, "acme/api&x=1")).searchParams.has("repo")).toBe(false);
  });

  it("encodes reserved characters", () => {
    const link = t3CodeLink("a & b = c? #d +e");
    expect(new URL(link).searchParams.get("prompt")).toBe("a & b = c? #d +e");
    expect(link).toContain("%26");
    expect(link).toContain("%23");
  });
});
