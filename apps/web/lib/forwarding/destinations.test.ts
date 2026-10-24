import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";
import { describe, expect, it } from "vitest";
import type { RequestRecord } from "@/lib/supabase/requests";
import { customChatPayload } from "./chat";
import { parseDestinationInput, templateProblem } from "./destination-input";
import { filterVerdict, outgoingFor } from "./worker";

const request: RequestRecord = {
  id: "7f3c9a2e-5b1d-4c8e-9a6f-2d4b8c1e7a90",
  endpointId: "e",
  method: "POST",
  path: "/stripe",
  headers: { "content-type": "application/json" },
  body: '{"type":"invoice.paid","data":{"amount":4200}}',
  queryParams: {},
  contentType: "application/json",
  ip: "203.0.113.7",
  size: 46,
  receivedAt: Date.UTC(2026, 0, 1),
  kind: "http",
};

const filter = (conditions: unknown[], logic = "and") => ({ logic, conditions }) as never;

describe("parseDestinationInput", () => {
  it("needs a URL to create", () => {
    expect(parseDestinationInput({}, { creating: true, allowPrivate: false })).toEqual({
      ok: false,
      error: "Enter the URL to send to.",
    });
  });

  it("turns the API's fields into changes", () => {
    const result = parseDestinationInput(
      {
        url: "https://api.example.com/hooks",
        name: " Billing ",
        http: true,
        email: false,
        format: "template",
        bodyTemplate: { event: "{{ json.type }}", signature: "{{ signature }}" },
        filter: { conditions: [{ field: "body_path", op: "eq", path: "type", value: "x" }] },
        throttleSeconds: 1,
        delaySeconds: 30,
      },
      { creating: true, allowPrivate: false }
    );
    expect(result).toEqual({
      ok: true,
      changes: {
        url: "https://api.example.com/hooks",
        name: "Billing",
        http: true,
        email: false,
        format: "template",
        bodyTemplate: { event: "{{ json.type }}", signature: "{{ signature }}" },
        filter: {
          logic: "and",
          conditions: [{ field: "body_path", op: "eq", path: "type", value: "x" }],
        },
        throttleSeconds: 1,
        delaySeconds: 30,
      },
    });
  });

  it("refuses placeholders the destination's kinds do not have", () => {
    const result = parseDestinationInput(
      { url: "https://a.example", http: true, email: false, messageTemplate: "{{ subject }}" },
      { creating: true, allowPrivate: false }
    );
    expect(result).toEqual({
      ok: false,
      error: "{{ subject }} is not a field of what this destination receives.",
    });
    expect(
      parseDestinationInput(
        { url: "https://a.example", email: true, messageTemplate: "{{ subject }}" },
        { creating: true, allowPrivate: false }
      ).ok
    ).toBe(true);
  });

  it("checks filters with RE2 and the filter fields", () => {
    expect(
      parseDestinationInput(
        {
          url: "https://a.example",
          filter: { conditions: [{ field: "path", op: "regex", value: "(?<=a)" }] },
        },
        { creating: true, allowPrivate: false }
      )
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^filter\.conditions\[0\]: regex: /),
    });
    expect(
      parseDestinationInput(
        {
          url: "https://a.example",
          filter: { conditions: [{ field: "signature", op: "eq", value: "verified" }] },
        },
        { creating: true, allowPrivate: false }
      ).ok
    ).toBe(true);
  });

  it("needs at least one kind, counting the stored ones", () => {
    expect(
      parseDestinationInput(
        { http: false },
        { creating: false, current: { http: true, email: false }, allowPrivate: false }
      )
    ).toEqual({ ok: false, error: "Pick at least one: HTTP requests or emails." });
  });

  it("refuses private URLs outside development and long waits", () => {
    expect(
      parseDestinationInput({ url: "ftp://a.example" }, { creating: true, allowPrivate: false }).ok
    ).toBe(false);
    expect(
      parseDestinationInput(
        { url: "https://a.example", delaySeconds: 7200 },
        { creating: true, allowPrivate: false }
      )
    ).toEqual({
      ok: false,
      error: "delaySeconds must be a whole number of seconds from 0 to 3600.",
    });
  });

  it("asks a template destination for its template", () => {
    expect(templateProblem({ format: "template", bodyTemplate: null })).toMatch(
      /needs its bodyTemplate/
    );
    expect(templateProblem({ format: "json", bodyTemplate: null })).toBeNull();
  });
});

describe("filterVerdict", () => {
  it("sends without a filter, and by the conditions with one", () => {
    expect(filterVerdict(null, request, null)).toBe("send");
    expect(
      filterVerdict(
        filter([{ field: "body_path", op: "eq", path: "type", value: "invoice.paid" }]),
        request,
        null
      )
    ).toBe("send");
    expect(
      filterVerdict(
        filter([{ field: "body_path", op: "gt", path: "data.amount", value: "5000" }]),
        request,
        null
      )
    ).toBe("skip");
  });

  it("waits for a signature check that has not reported yet", () => {
    const onSignature = filter([{ field: "signature", op: "eq", value: "verified" }]);
    const now = request.receivedAt + 1000;
    expect(filterVerdict(onSignature, request, "stripe", now)).toEqual({ waitMs: 2000 });
    // No signature check set up: it never reports, so the filter reads "missing".
    expect(filterVerdict(onSignature, request, null, now)).toBe("skip");
    expect(filterVerdict(onSignature, { ...request, signatureVerified: true }, "stripe", now)).toBe(
      "send"
    );
    // Not waited for forever.
    expect(filterVerdict(onSignature, request, "stripe", request.receivedAt + 60_000)).toBe("skip");
  });
});

describe("outgoingFor with templates", () => {
  const settings = {
    url: "https://api.example.com/in",
    appendPath: true,
    slug: "acme",
    name: null,
    showEmailExtracts: true,
    ownerHeaders: [["x-api-key", "k"]] as [string, string][],
    attempt: 1,
    secret: "whsec_c2VjcmV0LWZvci1jb25mb3JtYW5jZS10ZXN0cw==",
  };

  it("sends a filled-in JSON template, signed", async () => {
    const prepared = outgoingFor(request, {
      ...settings,
      format: "template",
      bodyTemplate: { kind: "{{ json.type }}", amount: "{{ json.data.amount }}", id: "{{ id }}" },
    });
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    const body = prepared.outgoing.body!.toString();
    expect(JSON.parse(body)).toEqual({ kind: "invoice.paid", amount: 4200, id: request.id });
    const headers = Object.fromEntries(prepared.outgoing.headers);
    expect(headers["x-api-key"]).toBe("k");
    await expect(verifyStandardWebhookSignature(body, headers, settings.secret)).resolves.toBe(
      true
    );
    expect(prepared.facts.format).toBe("template");
  });

  it("explains a template destination without a template", () => {
    expect(
      outgoingFor(request, { ...settings, format: "template", bodyTemplate: null })
    ).toMatchObject({
      reason: "The destination has no template.",
    });
  });

  it("posts the message template as a chat message", () => {
    const prepared = outgoingFor(request, {
      ...settings,
      url: "https://hooks.slack.com/services/T/B/X",
      format: "chat",
      messageTemplate: "Paid {{ json.data.amount }}",
    });
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    expect(JSON.parse(prepared.outgoing.body!.toString())).toEqual({
      text: "Paid 4200",
      content: "Paid 4200",
    });
  });
});

describe("customChatPayload", () => {
  it("escapes for Slack and silences Discord mentions", () => {
    expect(customChatPayload("<!channel> & co", "https://hooks.slack.com/services/x")).toEqual({
      text: "&lt;!channel&gt; &amp; co",
      content: "<!channel> & co",
    });
    expect(customChatPayload("@everyone", "https://discord.com/api/webhooks/1/x")).toEqual({
      text: "@everyone",
      content: "@everyone",
      allowed_mentions: { parse: [] },
    });
  });
});
