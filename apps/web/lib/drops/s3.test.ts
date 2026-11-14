import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * s3Put sends over a socket of its own (through the drop egress in
 * production), so the request is checked here as a server receives it: the
 * socket and the TLS layer are stood in for by a plain connection to a local
 * server, which sees exactly the headers the storage would.
 */

let port = 0;
vi.mock("./connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connect")>()),
  openDropSocket: async () => ({ socket: net.connect(port, "127.0.0.1") }),
}));
vi.mock("./tls", () => ({ secureSocket: async (socket: net.Socket) => socket }));

import { objectUrl, s3Put } from "./s3";

let server: Server;
const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const options = {
  region: "eu-central-1",
  bucket: "acme-drops",
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: "example-secret-not-real",
};

describe("s3Put", () => {
  it("sends the Host it signed over https: no :80, no :443", async () => {
    await s3Put(
      { ...options, endpoint: "https://s3.eu-central-1.amazonaws.com" },
      "orders/order-20261114-001500-abcdef12.csv",
      Buffer.from("Seq\n1\n"),
      "text/csv"
    );
    const request = seen.at(-1)!;
    expect(request.headers.host).toBe("acme-drops.s3.eu-central-1.amazonaws.com");
    expect(request.url).toBe("/orders/order-20261114-001500-abcdef12.csv");
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*\bhost\b/);
    expect(request.body).toBe("Seq\n1\n");
  });

  it("keeps a non-default port in the Host, path-style", async () => {
    await s3Put(
      { ...options, endpoint: "https://storage.acme.example:9443" },
      "a.csv",
      Buffer.from("x"),
      "text/csv"
    );
    const request = seen.at(-1)!;
    expect(request.headers.host).toBe("storage.acme.example:9443");
    expect(request.url).toBe("/acme-drops/a.csv");
  });

  it("addresses AWS buckets by host name and others by path", () => {
    expect(objectUrl({ endpoint: "https://s3.amazonaws.com", bucket: "b" }, "k").host).toBe(
      "b.s3.amazonaws.com"
    );
    expect(objectUrl({ endpoint: "https://fsn1.example.com", bucket: "b" }, "k").pathname).toBe(
      "/b/k"
    );
  });
});
