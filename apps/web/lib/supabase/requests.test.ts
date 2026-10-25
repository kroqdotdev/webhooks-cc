import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailCapture } from "@webhooks-cc/sdk/email";

const inFilter = vi.fn();
const select = vi.fn(() => ({ in: inFilter }));
const from = vi.fn(() => ({ select }));

vi.mock("./admin", () => ({
  createAdminClient: () => ({ from }),
}));

const { parseExtractsParam, withEmailExtracts } = await import("./requests");
type RequestRecord = import("./requests").RequestRecord;

function email(overrides: Partial<EmailCapture> = {}): EmailCapture {
  return {
    subject: "Confirm your email for Acme",
    from: [{ name: "Acme", address: "no-reply@acme.test" }],
    to: [{ name: null, address: "signup@mailhooks.cc" }],
    cc: [],
    replyTo: [],
    sender: [],
    date: null,
    messageId: null,
    inReplyTo: [],
    tag: null,
    text: "Your verification code is 482913",
    html: '<p><a href="https://app.acme.test/confirm?token=abc">Confirm email</a></p>',
    textFromHtml: false,
    attachments: [],
    auth: null,
    smtp: null,
    parseError: false,
    truncated: {
      raw: false,
      text: false,
      html: false,
      headers: false,
      addresses: false,
      attachments: false,
    },
    ...overrides,
  };
}

function record(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: "r1",
    endpointId: "e1",
    method: "POST",
    path: "/",
    headers: {},
    queryParams: {},
    ip: "192.0.2.1",
    size: 0,
    receivedAt: 1767225600000,
    kind: "http",
    email: null,
    ...overrides,
  };
}

const FOUND = {
  codes: ["482913"],
  links: [{ url: "https://app.acme.test/confirm?token=abc", label: "Confirm email", action: true }],
};

describe("parseExtractsParam", () => {
  it("is off unless asked for with true", () => {
    expect(parseExtractsParam(null)).toBe(false);
    expect(parseExtractsParam("false")).toBe(false);
    expect(parseExtractsParam("true")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const value of ["", "1", "yes", "TRUE", "true "]) {
      expect(parseExtractsParam(value), value).toBeNull();
    }
  });
});

describe("withEmailExtracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves HTTP requests alone without reading endpoints", async () => {
    const records = [record({ id: "a" }), record({ id: "b" })];
    await expect(withEmailExtracts(records)).resolves.toBe(records);
    expect(from).not.toHaveBeenCalled();
  });

  it("adds the codes and links the dashboard shows to each email", async () => {
    inFilter.mockResolvedValue({ data: [{ id: "e1", show_email_extracts: true }], error: null });
    const http = record({ id: "h" });
    const result = await withEmailExtracts([
      record({ id: "m", kind: "email", method: "EMAIL", email: email() }),
      http,
    ]);
    expect(from).toHaveBeenCalledWith("endpoints");
    expect(select).toHaveBeenCalledWith("id, show_email_extracts, email_fields");
    expect(inFilter).toHaveBeenCalledWith("id", ["e1"]);
    expect(result[0].extracts).toEqual(FOUND);
    expect(result[1]).toBe(http);
    expect(result[1]).not.toHaveProperty("extracts");
  });

  it("adds the endpoint's named fields and the reply text, whatever the switch says", async () => {
    inFilter.mockResolvedValue({
      data: [
        {
          id: "off",
          show_email_extracts: false,
          email_fields: [{ name: "code", from: "text", pattern: "code is (\\d+)" }],
        },
      ],
      error: null,
    });
    const [captured] = await withEmailExtracts([
      record({
        id: "r",
        endpointId: "off",
        kind: "email",
        email: email({ text: "Your code is 482913.\n\nOn Sat, Ada wrote:\n> Hi" }),
      }),
    ]);
    expect(captured.extracts).toBeNull();
    expect(captured.emailFields).toEqual({ code: "482913" });
    expect(captured.replyText).toBe("Your code is 482913.");
  });

  it("gives null when the endpoint turned extraction off", async () => {
    inFilter.mockResolvedValue({
      data: [
        { id: "on", show_email_extracts: true },
        { id: "off", show_email_extracts: false },
      ],
      error: null,
    });
    const [on, off] = await withEmailExtracts([
      record({ id: "a", endpointId: "on", kind: "email", email: email() }),
      record({ id: "b", endpointId: "off", kind: "email", email: email() }),
    ]);
    expect(on.extracts).toEqual(FOUND);
    expect(off.extracts).toBeNull();
    expect(inFilter).toHaveBeenCalledWith("id", ["on", "off"]);
  });

  it("gives null for an email without a parsed message or an endpoint that is gone", async () => {
    inFilter.mockResolvedValue({ data: [{ id: "e1", show_email_extracts: true }], error: null });
    const [unparsed, orphan] = await withEmailExtracts([
      record({ id: "a", kind: "email", email: null }),
      record({ id: "b", endpointId: "gone", kind: "email", email: email() }),
    ]);
    expect(unparsed.extracts).toBeNull();
    expect(orphan.extracts).toBeNull();
  });

  it("returns empty lists for an email with nothing to find", async () => {
    inFilter.mockResolvedValue({ data: [{ id: "e1", show_email_extracts: true }], error: null });
    const [result] = await withEmailExtracts([
      record({ kind: "email", email: email({ subject: "Hello", text: "Hi there", html: null }) }),
    ]);
    expect(result.extracts).toEqual({ codes: [], links: [] });
  });

  it("throws when the endpoint lookup fails", async () => {
    const error = { message: "boom" };
    inFilter.mockResolvedValue({ data: null, error });
    await expect(withEmailExtracts([record({ kind: "email", email: email() })])).rejects.toBe(
      error
    );
  });
});
