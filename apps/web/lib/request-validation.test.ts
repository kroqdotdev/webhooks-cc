import { describe, expect, test } from "vitest";
import { validateMockResponseField, validateNotificationUrl } from "./request-validation";

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

  test("valid http URL passes", () => {
    expect(validateNotificationUrl("http://localhost:3000/hook")).toEqual({ valid: true });
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
