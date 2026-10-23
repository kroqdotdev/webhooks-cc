import { describe, expect, it } from "vitest";
import {
  buildPayloadSchema,
  hasSchemaSample,
  isSchemaFormat,
  schemaGroupKey,
  schemaGroupLabel,
  schemaRootName,
  similarSchemaRequests,
  type SchemaSource,
} from "./payload-schema";

function request(overrides: Partial<SchemaSource> = {}): SchemaSource {
  return {
    _id: "req_1",
    method: "POST",
    path: "/hooks",
    headers: { "content-type": "application/json" },
    body: '{"id":"evt_1","amount":100}',
    contentType: "application/json",
    ...overrides,
  };
}

describe("payload schema helpers", () => {
  it("groups by detected event, else by method and path", () => {
    const stripe = request({ detectedProvider: "stripe", detectedEvent: "invoice.paid" });
    expect(schemaGroupKey(stripe)).toBe("event:stripe:invoice.paid");
    expect(schemaGroupKey({ ...stripe, path: "/other" })).toBe("event:stripe:invoice.paid");
    expect(schemaGroupLabel(stripe)).toBe("stripe invoice.paid");
    expect(schemaGroupKey(request())).toBe("route:POST /hooks");
    expect(schemaGroupLabel(request())).toBe("POST /hooks");
  });

  it("names the root type after the event", () => {
    expect(schemaRootName(request({ detectedEvent: "invoice.paid" }))).toBe("InvoicePaidEvent");
    expect(schemaRootName(request({ detectedEvent: "pull_request" }))).toBe("PullRequestEvent");
    expect(schemaRootName(request({ detectedEvent: "orders/create" }))).toBe("OrdersCreateEvent");
    expect(schemaRootName(request({ detectedEvent: "2fa.sent" }))).toBe("Webhook2faSentEvent");
    expect(schemaRootName(request())).toBe("WebhookPayload");
  });

  it("finds similar requests with a usable body, the selected one first", () => {
    const selected = request();
    const candidates = [
      request({ _id: "req_2", body: '{"id":"evt_2","amount":5,"note":"x"}' }),
      selected,
      request({ _id: "req_3", path: "/elsewhere" }),
      request({ _id: "req_4", body: "not json", contentType: "text/plain", headers: {} }),
      request({ _id: "req_5", kind: "email" }),
    ];
    const similar = similarSchemaRequests(selected, candidates);
    expect(similar.map((entry) => entry._id)).toEqual(["req_1", "req_2"]);

    const result = buildPayloadSchema(similar, "typescript", "Hook");
    expect(result.samples).toBe(2);
    expect(result.code).toContain("  note?: string;");
  });

  it("matches a search result by id, not by object identity", () => {
    const fromSearch = request({ _id: undefined, id: "req_1" });
    const similar = similarSchemaRequests(fromSearch, [request()]);
    expect(similar).toHaveLength(1);
  });

  it("knows which bodies have a schema", () => {
    expect(hasSchemaSample(request())).toBe(true);
    expect(
      hasSchemaSample(
        request({ body: "a=1", contentType: "application/x-www-form-urlencoded", headers: {} })
      )
    ).toBe(true);
    expect(hasSchemaSample(request({ body: "<a/>", contentType: "application/xml" }))).toBe(false);
    expect(isSchemaFormat("zod")).toBe(true);
    expect(isSchemaFormat("yaml")).toBe(false);
  });
});
