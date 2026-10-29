import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { AwsClient } from "aws4fetch";
import { allowPrivateTargets } from "@/lib/forwarding/config";
import { DropError, openDropSocket, type DropConnections } from "./connect";
import { secureSocket } from "./tls";

/**
 * S3-compatible drops: one signed PutObject per file (AWS, Cloudflare R2,
 * Hetzner, MinIO and the like), over a socket from openDropSocket so the
 * egress proxy and the SSRF rules apply here too. Path-style addressing
 * (endpoint/bucket/key) unless the endpoint is AWS's, where buckets are
 * addressed by host name.
 */

export interface S3Options {
  /** https://s3.eu-central-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, ... */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  tlsFingerprint?: string | null;
  /** The drop's connections, which its deadline ends. */
  connections?: DropConnections;
}

/** One object's whole request, answer included, however slowly it trickles. */
const REQUEST_TIMEOUT_MS = 120_000;

/** The endpoint as a URL, or why it cannot be one. */
export function s3EndpointProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter the storage endpoint as a URL, like https://s3.eu-central-1.amazonaws.com.";
  }
  if (url.username || url.password) return "Put the keys in their own fields, not in the URL.";
  if (url.protocol !== "https:" && !(allowPrivateTargets() && url.protocol === "http:")) {
    return "The endpoint must use https.";
  }
  if (url.pathname !== "/" && url.pathname !== "") return "Enter the endpoint without a path.";
  return null;
}

function isAws(host: string): boolean {
  return host === "amazonaws.com" || host.endsWith(".amazonaws.com");
}

/** Where an object goes: its URL, with each key segment encoded as S3 signs it. */
export function objectUrl(options: Pick<S3Options, "endpoint" | "bucket">, key: string): URL {
  const endpoint = new URL(options.endpoint);
  const path = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (isAws(endpoint.hostname)) {
    return new URL(`${endpoint.protocol}//${options.bucket}.${endpoint.host}/${path}`);
  }
  return new URL(
    `${endpoint.protocol}//${endpoint.host}/${encodeURIComponent(options.bucket)}/${path}`
  );
}

function s3Message(status: number, body: string): string {
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1];
  switch (code) {
    case "AccessDenied":
      return "The storage refused the keys: they need permission to write to the bucket.";
    case "InvalidAccessKeyId":
      return "The storage does not know that access key.";
    case "SignatureDoesNotMatch":
      return "The secret key does not match the access key.";
    case "NoSuchBucket":
      return "There is no bucket of that name at this endpoint.";
    case "AuthorizationHeaderMalformed":
    case "PermanentRedirect":
      return "The region or endpoint does not match the bucket's.";
    default:
      return `The storage answered ${status}${code ? ` (${code})` : ""}.`;
  }
}

/** Writes one object. */
export async function s3Put(
  options: S3Options,
  key: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  const problem = s3EndpointProblem(options.endpoint);
  if (problem) throw new DropError(problem, false);
  const url = objectUrl(options, key);
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  });
  const signed = await client.sign(url.toString(), {
    method: "PUT",
    body: new Uint8Array(data),
    headers: { "content-type": contentType, "content-length": String(data.byteLength) },
  });
  const headers: Record<string, string> = {};
  signed.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const { socket: raw } = await openDropSocket(url.hostname, port, {
    connections: options.connections,
  });
  let socket: net.Socket = raw;
  if (url.protocol === "https:") {
    socket = await secureSocket(raw, url.hostname, options.tlsFingerprint);
  }
  const transport = url.protocol === "https:" ? https : http;

  await new Promise<void>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "PUT",
        headers,
        // The connection is ours: checked, maybe through the proxy, TLS done.
        createConnection: () => socket,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < 8192) chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else
            reject(
              new DropError(
                s3Message(status, Buffer.concat(chunks).toString("utf8")),
                status >= 500 || status === 429
              )
            );
        });
        response.on("error", () => reject(new DropError("The storage connection broke.")));
      }
    );
    const deadline = setTimeout(
      () => request.destroy(new DropError("The storage did not answer in time.")),
      REQUEST_TIMEOUT_MS
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("error", (error) =>
      reject(
        error instanceof DropError ? error : new DropError("The storage could not be reached.")
      )
    );
    request.end(data);
  }).finally(() => socket.destroy());
}
