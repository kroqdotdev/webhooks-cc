import { describe, expect, it } from "vitest";
import type { ResponseRule } from "@webhooks-cc/sdk";
import { previewResponse } from "./response-preview";
import type { RequestRecord } from "./supabase/requests";

const request: RequestRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  endpointId: "e",
  method: "POST",
  path: "/billing",
  headers: { "content-type": "application/json", "x-event": "invoice.paid" },
  body: '{"type":"invoice.paid","data":{"id":"in_1","amount":4200}}',
  queryParams: { mode: "test" },
  contentType: "application/json",
  ip: "203.0.113.7",
  size: 58,
  receivedAt: Date.UTC(2026, 0, 1),
  kind: "http",
};
const endpoint = { slug: "acme", name: "Acme" };
const generated = { uuid: "00000000-0000-4000-8000-000000000000", now: "2026-01-01T00:00:00.000Z" };

const rule = (overrides: Partial<ResponseRule>): ResponseRule => ({
  conditions: [{ field: "body_path", op: "eq", path: "type", value: "invoice.paid" }],
  response: { status: 201, body: '{"id": "{{ json.data.id }}"}', headers: {} },
  ...overrides,
});

describe("previewResponse", () => {
  it("names the first rule that matches and fills in its response", () => {
    const preview = previewResponse(
      {
        mockResponse: { status: 200, body: "default", headers: {} },
        responseRules: [
          rule({ conditions: [{ field: "method", op: "eq", value: "GET" }] }),
          rule({
            name: "Invoices",
            response: {
              status: 201,
              body: '{"id": "{{ json.data.id }}", "amount": {{ json.data.amount }}, "uuid": "{{ uuid }}"}',
              headers: { "x-mode": "{{ query.mode | upper }}", "x-bad": "{{ body }}\r\nx: y" },
              delay: 50,
            },
          }),
        ],
      },
      request,
      endpoint,
      generated
    );
    expect(preview.rule).toEqual({ index: 1, name: "Invoices" });
    expect(preview.response).toEqual({
      status: 201,
      body: `{"id": "in_1", "amount": 4200, "uuid": "${generated.uuid}"}`,
      // A header that ends up holding a line break is dropped, as the receiver does.
      headers: { "x-mode": "TEST" },
      delay: 50,
    });
  });

  it("skips rules that are off or have no conditions", () => {
    const preview = previewResponse(
      {
        mockResponse: null,
        responseRules: [rule({ enabled: false }), rule({ conditions: [] })],
      },
      request,
      endpoint,
      generated
    );
    expect(preview.rule).toBeNull();
    expect(preview.response).toBeNull();
  });

  it("falls back to the default response", () => {
    const preview = previewResponse(
      {
        mockResponse: { status: 418, body: "{{ method }} {{ nope }}", headers: {} },
        responseRules: null,
      },
      request,
      endpoint,
      generated
    );
    expect(preview.response?.body).toBe("POST {{ nope }}");
    expect(preview.unknownPlaceholders).toEqual(["{{ nope }}"]);
  });

  it("says emails get the mail-server reply", () => {
    const preview = previewResponse(
      { mockResponse: { status: 500, body: "", headers: {} }, responseRules: null },
      { ...request, kind: "email", email: null },
      endpoint,
      generated
    );
    expect(preview.email).toBe(true);
    expect(preview.response).toBeNull();
  });
});
