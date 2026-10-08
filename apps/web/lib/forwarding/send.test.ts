import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDelivered, sendForward } from "./send";

let server: Server;
let base: string;
let lastRequest: { headers: IncomingMessage["headers"]; body: string } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body };
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"received":true}');
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/ok" }).end();
      } else if (req.url === "/big") {
        res.writeHead(500).end("x".repeat(10_000));
      } else if (req.url === "/hang") {
        // Never answers.
      } else if (req.url === "/proxy") {
        // A stand-in for the notify proxy's forward mode.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: 202, body: `to ${req.headers["x-target-url"]}` }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const local = { timeoutMs: 2000, proxy: null, allowPrivate: true };
const headers = { "content-type": "application/json", "webhook-id": "msg_1" };

describe("sendForward, direct", () => {
  it("posts the body with its headers and keeps the response start", async () => {
    const result = await sendForward(`${base}/ok`, headers, '{"a":1}', local);
    expect(result).toMatchObject({ status: 200, excerpt: '{"received":true}', error: null });
    expect(isDelivered(result)).toBe(true);
    expect(lastRequest?.body).toBe('{"a":1}');
    expect(lastRequest?.headers["webhook-id"]).toBe("msg_1");
  });

  it("does not follow redirects, which do not count as delivered", async () => {
    const result = await sendForward(`${base}/redirect`, headers, "{}", local);
    expect(result.status).toBe(302);
    expect(isDelivered(result)).toBe(false);
  });

  it("keeps only the first 1 KB of a response", async () => {
    const result = await sendForward(`${base}/big`, headers, "{}", local);
    expect(result.status).toBe(500);
    expect(result.excerpt!.length).toBeLessThanOrEqual(1024 + 16 * 1024);
    expect(result.excerpt!.length).toBeGreaterThanOrEqual(1024);
  });

  it("gives up after the timeout", async () => {
    const result = await sendForward(`${base}/hang`, headers, "{}", { ...local, timeoutMs: 300 });
    expect(result).toMatchObject({ status: null, error: "No answer within 1 s." });
  });

  it("refuses local addresses unless allowed", async () => {
    const result = await sendForward(`${base}/ok`, headers, "{}", {
      ...local,
      allowPrivate: false,
    });
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/https|public host/);
  });

  it("reports a refused connection", async () => {
    const result = await sendForward("http://127.0.0.1:1/x", headers, "{}", local);
    expect(result).toMatchObject({ status: null, error: "The connection was refused." });
  });
});

describe("sendForward, through the proxy", () => {
  it("fails rather than sending directly when the proxy has no secret", async () => {
    const before = lastRequest;
    const result = await sendForward(`${base}/ok`, headers, "{}", {
      ...local,
      proxy: { url: `${base}/proxy`, secret: "" },
    });
    expect(result).toMatchObject({ status: null, error: expect.stringMatching(/NOTIFY_SECRET/) });
    expect(lastRequest).toBe(before);
  });

  it("reads the destination's status and body start from the proxy's answer", async () => {
    const result = await sendForward("https://api.example.com/hook", headers, "{}", {
      ...local,
      proxy: { url: `${base}/proxy`, secret: "s" },
    });
    expect(result).toMatchObject({ status: 202, excerpt: "to https://api.example.com/hook" });
    expect(lastRequest?.headers["x-proxy-mode"]).toBe("forward");
    expect(lastRequest?.headers["x-auth"]).toBe("s");
    expect(lastRequest?.headers["webhook-id"]).toBe("msg_1");
  });
});
