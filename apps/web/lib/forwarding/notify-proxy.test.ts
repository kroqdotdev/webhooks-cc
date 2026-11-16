import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import notifyProxy from "../../../../infra/notify-proxy/src/worker";
import type { RequestRecord } from "@/lib/supabase/requests";
import { sendForward } from "./send";
import { outgoingFor, type OutgoingSettings } from "./worker";

/**
 * The web app's sender and the notify-proxy Worker (infra/notify-proxy)
 * together: the Worker's own code runs behind a local server, and what it
 * would post to the destination is caught at its fetch. A SendGrid or
 * Mailgun form with a binary file has to reach the destination as the same
 * bytes through the Worker as when sent directly.
 */

const SECRET = `whsec_${Buffer.alloc(24, 7).toString("base64")}`;
const PROXY_SECRET = "proxy-secret";
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);

let proxy: Server;
let proxyUrl: string;
let direct: Server;
let directUrl: string;
let directSeen: { headers: Record<string, string | string[] | undefined>; body: Buffer } | null;

const realFetch = globalThis.fetch;
/** What the Worker sent on to the destination. */
let workerSent: { url: string; method: string; headers: Headers; body: Buffer } | null = null;

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  // The Worker behind a local server, as Cloudflare would run it.
  proxy = createServer(async (req, res) => {
    const body = await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const answer = await notifyProxy.fetch(
      new Request(`http://worker${req.url}`, {
        method: req.method,
        headers,
        body: Uint8Array.from(body),
      }),
      { NOTIFY_SECRET: PROXY_SECRET }
    );
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;

  // A destination for the direct path.
  direct = createServer(async (req, res) => {
    directSeen = { headers: req.headers, body: await readBody(req) };
    res.writeHead(202).end("ok");
  });
  await new Promise<void>((resolve) => direct.listen(0, "127.0.0.1", resolve));
  directUrl = `http://127.0.0.1:${(direct.address() as AddressInfo).port}/inbound`;

  // The Worker's own fetch to the destination is caught; the hop to the
  // Worker itself goes through.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(proxyUrl)) return realFetch(input, init);
    const request = new Request(input, init);
    workerSent = {
      url,
      method: request.method,
      headers: request.headers,
      body: Buffer.from(await request.arrayBuffer()),
    };
    return new Response("accepted", { status: 202 });
  });
});

afterEach(() => {
  workerSent = null;
  directSeen = null;
});

afterAll(() => {
  vi.unstubAllGlobals();
  proxy.closeAllConnections();
  proxy.close();
  direct.closeAllConnections();
  direct.close();
});

function emailWithFiles(): RequestRecord {
  return {
    id: "6b3f2c1e-0000-4000-8000-000000000002",
    endpointId: "e1",
    method: "EMAIL",
    path: "acme-orders@mailhooks.cc",
    headers: { from: "Acme <billing@acme.example>", subject: "Invoice" },
    body: "From: Acme <billing@acme.example>\r\nSubject: Invoice\r\n\r\nAttached.",
    queryParams: {},
    ip: "203.0.113.9",
    size: 64,
    receivedAt: Date.parse("2026-11-16T10:00:00.000Z"),
    kind: "email",
    email: {
      subject: "Invoice",
      from: [{ name: "Acme", address: "billing@acme.example" }],
      to: [{ name: null, address: "acme-orders@mailhooks.cc" }],
      cc: [],
      replyTo: [],
      sender: [],
      date: null,
      messageId: null,
      inReplyTo: [],
      tag: null,
      text: "Attached.",
      html: null,
      textFromHtml: false,
      attachments: [
        {
          filename: "invoice.pdf",
          contentType: "application/pdf",
          size: PDF.byteLength,
          contentId: null,
          inline: false,
          content: PDF.toString("base64"),
        },
      ],
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
    },
  };
}

function settings(overrides: Partial<OutgoingSettings>): OutgoingSettings {
  return {
    url: "https://app.acme.example/inbound",
    format: "sendgrid",
    appendPath: false,
    slug: "acme-orders",
    name: null,
    showEmailExtracts: false,
    ownerHeaders: [],
    attempt: 1,
    secret: SECRET,
    ...overrides,
  };
}

const viaProxy = { timeoutMs: 5000, proxy: null, allowPrivate: true };

describe("a form with a binary file, through the notify-proxy Worker", () => {
  it.each([
    ["sendgrid", "forward", []],
    ["mailgun", "forward", []],
    ["sendgrid", "relay", [["x-acme-env", "test"]]],
  ] as const)(
    "%s in %s mode reaches the destination as the same bytes",
    async (format, mode, owner) => {
      const prepared = outgoingFor(
        emailWithFiles(),
        settings({ format, ownerHeaders: owner.map(([n, v]) => [n, v] as [string, string]) })
      );
      if (!("outgoing" in prepared)) throw new Error(prepared.reason);
      const { outgoing } = prepared;
      expect(outgoing.mode).toBe(mode);
      expect(outgoing.body!.includes(PDF)).toBe(true);

      const result = await sendForward(outgoing, {
        ...viaProxy,
        proxy: { url: proxyUrl, secret: PROXY_SECRET },
      });
      expect(result).toMatchObject({ status: 202, error: null });
      expect(workerSent?.url).toBe("https://app.acme.example/inbound");
      expect(workerSent?.method).toBe("POST");
      expect(workerSent?.body.equals(outgoing.body!)).toBe(true);
      const sent = Object.fromEntries(outgoing.headers);
      expect(workerSent?.headers.get("content-type")).toBe(sent["content-type"]);
      expect(workerSent?.headers.get("webhook-signature")).toBe(sent["webhook-signature"]);
      if (mode === "relay") expect(workerSent?.headers.get("x-acme-env")).toBe("test");

      // The direct path, without the proxy, sends the very same bytes.
      const directResult = await sendForward({ ...outgoing, url: directUrl }, viaProxy);
      expect(directResult.status).toBe(202);
      expect(directSeen?.body.equals(workerSent!.body)).toBe(true);
      expect(directSeen?.headers["content-type"]).toBe(sent["content-type"]);
    }
  );

  it("still posts a JSON delivery's text unchanged in forward mode", async () => {
    const prepared = outgoingFor(emailWithFiles(), settings({ format: "postmark" }));
    if (!("outgoing" in prepared)) throw new Error(prepared.reason);
    await sendForward(prepared.outgoing, {
      ...viaProxy,
      proxy: { url: proxyUrl, secret: PROXY_SECRET },
    });
    expect(workerSent?.body.toString("utf8")).toBe(prepared.outgoing.body!.toString("utf8"));
    expect(JSON.parse(workerSent!.body.toString("utf8")).Attachments[0].Content).toBe(
      PDF.toString("base64")
    );
  });
});
