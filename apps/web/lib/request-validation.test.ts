import { describe, expect, it, test, vi } from "vitest";
import { z } from "zod";
import {
  isPlainEmailAddress,
  parseJsonBody,
  parseJsonBodyWith,
  validateMockResponseField,
  validateNotificationUrl,
  validateResponseRules,
} from "./request-validation";

describe("validateMockResponseField", () => {
  // -----------------------------------------------------------------------
  // Passthrough cases
  // -----------------------------------------------------------------------
  test("undefined passes (no mock response)", () => {
    expect(validateMockResponseField(undefined)).toEqual({ valid: true });
  });

  test("null passes (clear mock response)", () => {
    expect(validateMockResponseField(null)).toEqual({ valid: true });
  });

  // -----------------------------------------------------------------------
  // Full mode (partial=false, default) — all fields required
  // -----------------------------------------------------------------------
  test("valid complete mock response passes", () => {
    expect(
      validateMockResponseField({ status: 200, body: "OK", headers: { "x-test": "1" } })
    ).toEqual({ valid: true });
  });

  test("valid mock response with delay passes", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {}, delay: 1000 })).toEqual({
      valid: true,
    });
  });

  test("extra fields are ignored (not rejected)", () => {
    expect(
      validateMockResponseField({ status: 200, body: "", headers: {}, extra: "field" })
    ).toEqual({ valid: true });
  });

  test("rejects non-object value", () => {
    expect(validateMockResponseField("string").valid).toBe(false);
    expect(validateMockResponseField(42).valid).toBe(false);
    expect(validateMockResponseField(true).valid).toBe(false);
  });

  test("rejects array value", () => {
    expect(validateMockResponseField([1, 2, 3]).valid).toBe(false);
  });

  // Status validation
  test("rejects missing status in full mode", () => {
    const result = validateMockResponseField({ body: "", headers: {} });
    expect(result.valid).toBe(false);
  });

  test("rejects status below 100", () => {
    expect(validateMockResponseField({ status: 99, body: "", headers: {} }).valid).toBe(false);
  });

  test("rejects status above 599", () => {
    expect(validateMockResponseField({ status: 600, body: "", headers: {} }).valid).toBe(false);
  });

  test("rejects non-integer status", () => {
    expect(validateMockResponseField({ status: 200.5, body: "", headers: {} }).valid).toBe(false);
  });

  test("rejects string status", () => {
    expect(validateMockResponseField({ status: "200", body: "", headers: {} }).valid).toBe(false);
  });

  test("accepts boundary status 100", () => {
    expect(validateMockResponseField({ status: 100, body: "", headers: {} }).valid).toBe(true);
  });

  test("accepts boundary status 599", () => {
    expect(validateMockResponseField({ status: 599, body: "", headers: {} }).valid).toBe(true);
  });

  // Body validation
  test("rejects missing body in full mode", () => {
    expect(validateMockResponseField({ status: 200, headers: {} }).valid).toBe(false);
  });

  test("rejects non-string body", () => {
    expect(validateMockResponseField({ status: 200, body: 123, headers: {} }).valid).toBe(false);
  });

  test("accepts empty string body", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {} }).valid).toBe(true);
  });

  // Headers validation
  test("rejects missing headers in full mode", () => {
    expect(validateMockResponseField({ status: 200, body: "" }).valid).toBe(false);
  });

  test("rejects array headers", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: [] }).valid).toBe(false);
  });

  test("rejects null headers", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: null }).valid).toBe(false);
  });

  test("rejects non-string header values", () => {
    expect(
      validateMockResponseField({ status: 200, body: "", headers: { "x-test": 42 } }).valid
    ).toBe(false);
  });

  test("accepts empty headers object", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {} }).valid).toBe(true);
  });

  // Delay validation
  test("rejects negative delay", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {}, delay: -1 }).valid).toBe(
      false
    );
  });

  test("rejects delay above 30000", () => {
    expect(
      validateMockResponseField({ status: 200, body: "", headers: {}, delay: 30001 }).valid
    ).toBe(false);
  });

  test("rejects non-integer delay", () => {
    expect(
      validateMockResponseField({ status: 200, body: "", headers: {}, delay: 100.5 }).valid
    ).toBe(false);
  });

  test("accepts delay of 0", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {}, delay: 0 }).valid).toBe(
      true
    );
  });

  test("accepts delay of 30000", () => {
    expect(
      validateMockResponseField({ status: 200, body: "", headers: {}, delay: 30000 }).valid
    ).toBe(true);
  });

  test("accepts undefined delay (optional)", () => {
    expect(validateMockResponseField({ status: 200, body: "", headers: {} }).valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Partial mode (partial=true) — PATCH semantics, all fields optional
  // -----------------------------------------------------------------------
  test("partial: allows missing status", () => {
    expect(validateMockResponseField({ body: "ok", headers: {} }, true).valid).toBe(true);
  });

  test("partial: allows missing body", () => {
    expect(validateMockResponseField({ status: 200, headers: {} }, true).valid).toBe(true);
  });

  test("partial: allows missing headers", () => {
    expect(validateMockResponseField({ status: 200, body: "" }, true).valid).toBe(true);
  });

  test("partial: allows only delay", () => {
    expect(validateMockResponseField({ delay: 500 }, true).valid).toBe(true);
  });

  test("partial: allows empty object", () => {
    expect(validateMockResponseField({}, true).valid).toBe(true);
  });

  test("partial: still rejects invalid status when present", () => {
    expect(validateMockResponseField({ status: 9999 }, true).valid).toBe(false);
  });

  test("partial: still rejects invalid body when present", () => {
    expect(validateMockResponseField({ body: 123 }, true).valid).toBe(false);
  });

  test("partial: still rejects invalid headers when present", () => {
    expect(validateMockResponseField({ headers: "bad" }, true).valid).toBe(false);
  });

  test("partial: still rejects invalid delay when present", () => {
    expect(validateMockResponseField({ delay: -1 }, true).valid).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Error response format
  // -----------------------------------------------------------------------
  test("failure returns Response with 400 status", async () => {
    const result = validateMockResponseField("bad");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.response.status).toBe(400);
      const json = await result.response.json();
      expect(json.error).toBeTruthy();
    }
  });
});

describe("validateNotificationUrl", () => {
  test("undefined passes", () => {
    expect(validateNotificationUrl(undefined)).toEqual({ valid: true });
  });

  test("null passes", () => {
    expect(validateNotificationUrl(null)).toEqual({ valid: true });
  });

  test("empty string passes", () => {
    expect(validateNotificationUrl("")).toEqual({ valid: true });
  });

  test("valid https URL passes", () => {
    expect(validateNotificationUrl("https://example.com/hook")).toEqual({ valid: true });
  });

  test("http and local URLs pass only where private targets are allowed", () => {
    expect(validateNotificationUrl("http://localhost:3000/hook").valid).toBe(false);
    expect(validateNotificationUrl("https://10.0.0.5/hook").valid).toBe(false);
    expect(validateNotificationUrl("http://localhost:3000/hook", { allowPrivate: true })).toEqual({
      valid: true,
    });
  });

  test("rejects non-http protocol", () => {
    expect(validateNotificationUrl("ftp://example.com").valid).toBe(false);
  });

  test("rejects string longer than 2048", () => {
    const long = "https://example.com/" + "a".repeat(2030);
    expect(validateNotificationUrl(long).valid).toBe(false);
  });

  test("rejects non-string", () => {
    expect(validateNotificationUrl(42).valid).toBe(false);
  });
});

describe("isPlainEmailAddress", () => {
  it("accepts plain addresses", () => {
    expect(isPlainEmailAddress("dev+run-1@example.com")).toBe(true);
    expect(isPlainEmailAddress("first.last@sub.example.co.uk")).toBe(true);
  });

  it("refuses strings the mailer would read as other recipients", () => {
    for (const value of [
      "x<slug@mailhooks.cc>",
      "slug@mailhooks.cc>",
      "slug@mailhooks.cc(c)",
      "slug@mailhooks.cc,x.com",
      "slug@mailhooks.cc;x.com",
      "a:slug@mailhooks.cc;",
      "slug@ｍailhooks.cc",
      "slug@mailhooks.cc​",
      "slug@mailhooks.cc.",
      "slug@localhost",
      "two@at@example.com",
      `${"a".repeat(250)}@b.cc`,
    ]) {
      expect(isPlainEmailAddress(value), value).toBe(false);
    }
  });
});

describe("validateResponseRules", () => {
  const rule = (conditions: unknown[]) => ({
    conditions,
    response: { status: 200, body: "", headers: {} },
  });
  const error = async (result: ReturnType<typeof validateResponseRules>) =>
    result.valid ? null : ((await result.response.json()) as { error: string }).error;

  test("accepts the rule language's fields and operators", () => {
    expect(
      validateResponseRules([
        rule([
          { field: "path", op: "regex", value: "^/v[0-9]+/" },
          { field: "header", op: "not_exists", name: "x-test" },
          { field: "body_path", op: "lte", path: "data.amount", value: "100" },
          { field: "body", op: "not_contains", value: "test" },
          { field: "content_type", op: "contains", value: "json" },
        ]),
      ])
    ).toEqual({ valid: true });
  });

  test("refuses a regular expression RE2 cannot compile", async () => {
    expect(
      await error(validateResponseRules([rule([{ field: "path", op: "regex", value: "(?<=a)b" }])]))
    ).toMatch(/^responseRules\[0\]\.conditions\[0\]: regex: /);
  });

  test("refuses fields only filters can read", async () => {
    expect(
      await error(validateResponseRules([rule([{ field: "kind", op: "eq", value: "email" }])]))
    ).toMatch(/forwarding filter/);
  });

  test("refuses text for a number operator", async () => {
    expect(
      await error(validateResponseRules([rule([{ field: "size", op: "gt", value: "lots" }])]))
    ).toMatch(/must be a number/);
  });
});

function post(body: string, headers?: Record<string, string>) {
  return new Request("https://webhooks.cc/api/test", { method: "POST", body, headers });
}

async function refusal(result: { data: unknown } | { error: Response }) {
  if (!("error" in result)) throw new Error("expected the body to be refused");
  return { status: result.error.status, body: await result.error.json() };
}

describe("parseJsonBody", () => {
  test("returns a JSON object", async () => {
    expect(await parseJsonBody(post('{"a":1}'))).toEqual({ data: { a: 1 } });
  });

  test("keeps its messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refusal(await parseJsonBody(post("{")))).toEqual({
      status: 400,
      body: { error: "Invalid JSON" },
    });
    for (const body of ["null", "[]", '"text"', "5"]) {
      expect(await refusal(await parseJsonBody(post(body)))).toEqual({
        status: 400,
        body: { error: "Expected JSON object" },
      });
    }
    expect(await refusal(await parseJsonBody(post('{"a":"long"}'), 4))).toEqual({
      status: 413,
      body: { error: "Request body too large (max 4 bytes)" },
    });
    vi.restoreAllMocks();
  });
});

describe("parseJsonBodyWith", () => {
  const schema = z.object({ name: z.string().nullish(), other: z.unknown().optional() });

  test("returns the data the schema describes, without unknown fields", async () => {
    const result = await parseJsonBodyWith(post('{"name":"Acme","extra":true}'), schema);
    expect(result).toEqual({ data: { name: "Acme" } });
  });

  test("leaves a field that was not sent out of the data", async () => {
    const result = await parseJsonBodyWith(post("{}"), schema);
    if (!("data" in result)) throw new Error("expected data");
    expect("other" in result.data).toBe(false);
    const sent = await parseJsonBodyWith(post('{"other":null}'), schema);
    expect(sent).toEqual({ data: { other: null } });
  });

  test.each(["null", "[]", '"text"', "5", '{"name":1}', '{"name":{"a":1}}'])(
    "refuses %s with a 400",
    async (body) => {
      expect(await refusal(await parseJsonBodyWith(post(body), schema))).toEqual({
        status: 400,
        body: { error: "Invalid request body" },
      });
    }
  );

  test("refuses a body that is not JSON, or empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const body of ["{", ""]) {
      expect(await refusal(await parseJsonBodyWith(post(body), schema))).toEqual({
        status: 400,
        body: { error: "Invalid request body" },
      });
    }
    vi.restoreAllMocks();
  });

  test("uses the route's own wording", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const options = { message: "invalid_body", invalidJson: "invalid_json" };
    expect(await refusal(await parseJsonBodyWith(post("null"), schema, options))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(await refusal(await parseJsonBodyWith(post("{"), schema, options))).toEqual({
      status: 400,
      body: { error: "invalid_json" },
    });
    expect(
      await refusal(await parseJsonBodyWith(post("{"), schema, { message: "Invalid JSON." }))
    ).toEqual({ status: 400, body: { error: "Invalid JSON." } });
    vi.restoreAllMocks();
  });

  test("answers 413 past the size limit, by header or by bytes", async () => {
    const body = JSON.stringify({ name: "x".repeat(100) });
    expect(await refusal(await parseJsonBodyWith(post(body), schema, { maxSize: 50 }))).toEqual({
      status: 413,
      body: { error: "Request body too large (max 50 bytes)" },
    });
    const claimed = post("{}", { "Content-Length": "100000" });
    expect((await refusal(await parseJsonBodyWith(claimed, schema))).status).toBe(413);
    expect(await parseJsonBodyWith(post(body), schema, { maxSize: 200 })).toHaveProperty("data");
  });

  test("builds its refusals with the route's response function", async () => {
    const respond = (body: { error: string }, init: { status: number }) =>
      Response.json(body, { ...init, headers: { "Cache-Control": "no-store" } });
    const result = await parseJsonBodyWith(post("[]"), schema, { respond });
    if (!("error" in result)) throw new Error("expected a refusal");
    expect(result.error.status).toBe(400);
    expect(result.error.headers.get("Cache-Control")).toBe("no-store");
  });
});
