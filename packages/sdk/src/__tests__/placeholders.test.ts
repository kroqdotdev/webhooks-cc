import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_ROOTS,
  REQUEST_TEMPLATE_ROOTS,
  RESPONSE_TEMPLATE_ROOTS,
  TemplateTooLargeError,
  emailTemplateContext,
  hasPlaceholders,
  renderJsonTemplate,
  renderTemplate,
  requestTemplateContext,
  unknownJsonPlaceholders,
  unknownPlaceholders,
} from "../placeholders";

const request = requestTemplateContext(
  {
    id: "req_1",
    method: "POST",
    path: "/stripe",
    headers: { "Stripe-Signature": "t=1,v1=abc" },
    query: {},
    body: '{"type":"invoice.paid","data":{"object":{"id":"in_1","total":4200,"lines":[1,2]}}}',
    contentType: "application/json",
    ip: "203.0.113.7",
    size: 80,
    receivedAt: Date.UTC(2026, 0, 1),
    endpoint: { slug: "acme", name: null },
  },
  { signature: "verified" }
);

describe("renderJsonTemplate", () => {
  it("keeps the type of a lone placeholder", () => {
    expect(
      renderJsonTemplate(
        {
          text: "Invoice {{ json.data.object.id }} paid",
          total: "{{ json.data.object.total }}",
          lines: "{{ json.data.object.lines }}",
          missing: "{{ json.nope }}",
          verified: "{{ signature }}",
          nested: [{ id: "{{ id }}" }],
        },
        request
      )
    ).toEqual({
      text: "Invoice in_1 paid",
      total: 4200,
      lines: [1, 2],
      missing: null,
      verified: "verified",
      nested: [{ id: "req_1" }],
    });
  });

  it("leaves unknown placeholders and keys alone", () => {
    expect(renderJsonTemplate({ "{{ id }}": "{{ nope }}" }, request)).toEqual({
      "{{ id }}": "{{ nope }}",
    });
  });

  it("applies filters to a lone placeholder", () => {
    expect(renderJsonTemplate({ t: "{{ json.type | upper }}" }, request)).toEqual({
      t: "INVOICE.PAID",
    });
  });

  it("stops a template that repeats a large value", () => {
    const big = requestTemplateContext({
      id: "r",
      method: "POST",
      path: "/",
      headers: {},
      query: {},
      body: "x".repeat(1000),
      contentType: null,
      ip: "",
      size: 1000,
      receivedAt: 0,
      endpoint: { slug: "s", name: null },
    });
    const template = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, "{{ body }}"])
    );
    expect(() => renderJsonTemplate(template, big, { maxBytes: 10_000 })).toThrow(
      TemplateTooLargeError
    );
    expect(() => renderJsonTemplate(template, big, { maxBytes: 30_000 })).not.toThrow();
  });
});

describe("renderTemplate", () => {
  it("returns a string without placeholders as it is", () => {
    expect(renderTemplate("{ok}", request)).toBe("{ok}");
  });

  it("generates a uuid and the time when not given", () => {
    const out = renderTemplate("{{ uuid }} {{ now }}", request);
    expect(out).toMatch(/^[0-9a-f-]{36} \d{4}-\d\d-\d\dT/);
  });
});

describe("unknownPlaceholders", () => {
  it("lists placeholders the context cannot fill", () => {
    expect(
      unknownPlaceholders("{{ subjct }} {{ json.a }} {{ uuid }}", RESPONSE_TEMPLATE_ROOTS)
    ).toEqual(["{{ subjct }}"]);
  });

  it("knows signature only where the worker sets it", () => {
    expect(unknownPlaceholders("{{ signature }}", RESPONSE_TEMPLATE_ROOTS)).toHaveLength(1);
    expect(unknownPlaceholders("{{ signature }}", REQUEST_TEMPLATE_ROOTS)).toHaveLength(0);
  });

  it("walks JSON templates", () => {
    expect(
      unknownJsonPlaceholders(
        { a: ["{{ nope }}", { b: "{{ nope }} {{ subject }}" }] },
        EMAIL_TEMPLATE_ROOTS
      )
    ).toEqual(["{{ nope }}"]);
  });

  it("tells whether a string has placeholders", () => {
    expect(hasPlaceholders("{{ a }}")).toBe(true);
    expect(hasPlaceholders("{{ }}")).toBe(false);
  });
});

describe("emailTemplateContext", () => {
  const data = {
    id: "req_e",
    subject: "Your code",
    from: { name: "Acme", address: "no-reply@acme.example" },
    headers: { "Message-ID": "<1@acme.example>" },
  };

  it("reads the email JSON and lowercases header names", () => {
    const context = emailTemplateContext(data, { signature: null });
    expect(renderTemplate("{{ subject }} from {{ from.address }}", context)).toBe(
      "Your code from no-reply@acme.example"
    );
    expect(renderTemplate("{{ headers.Message-ID }}", context)).toBe("<1@acme.example>");
    expect(renderTemplate("{{ signature }}", context)).toBe("missing");
  });

  it("fills codes with nothing when the endpoint does not find them", () => {
    expect(renderTemplate("[{{ codes.0 }}]", emailTemplateContext(data))).toBe("[]");
  });

  it("leaves signature out unless given", () => {
    expect(renderTemplate("{{ signature }}", emailTemplateContext(data))).toBe("{{ signature }}");
  });
});

describe("renderTemplate maxBytes", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text).length;

  it("cuts a long value at a character boundary, quickly", () => {
    const value = "aé€😀".repeat(250_000);
    const started = performance.now();
    const out = renderTemplate("{{ v }}", { v: value }, { maxBytes: 200_000 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(utf8(out)).toBeLessThanOrEqual(200_000);
    expect(value.startsWith(out)).toBe(true);
    // Nothing that would still fit was left out: the next character would not.
    const next = String.fromCodePoint(value.codePointAt(out.length)!);
    expect(utf8(out) + utf8(next)).toBeGreaterThan(200_000);
  });

  it("never splits a surrogate pair or a multibyte character", () => {
    for (let max = 1; max <= 12; max++) {
      const out = renderTemplate("x{{ v }}", { v: "😀é😀" }, { maxBytes: max });
      expect(utf8(out)).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|�/);
      expect("x😀é😀".startsWith(out)).toBe(true);
    }
  });
});
