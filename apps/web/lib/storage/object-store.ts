import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { serverEnv } from "@/lib/env";

/**
 * S3-compatible object storage, where the receiver keeps captured email:
 * `m/{request_id}/raw.eml` (the exact message) and `m/{request_id}/a/{i}`
 * (attachment i's decoded contents). The receiver writes; the web app reads,
 * hands out short-lived presigned links and deletes. Path-style URLs, so any
 * S3-compatible service works (Hetzner in production, SeaweedFS in dev).
 */

export interface ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** A request's objects live under this prefix (requests.object_prefix). */
export const OBJECT_PREFIX = /^m\/[0-9a-f-]{36}\/$/;

/** The settings, or null when object storage is not configured. */
export function objectStorageConfig(): ObjectStorageConfig | null {
  const env = serverEnv();
  const endpoint = env.OBJECT_STORAGE_ENDPOINT;
  const bucket = env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  const set = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 4) {
    // Half configured is a mistake worth stopping for, as in the receiver:
    // stored messages would read as missing and nothing would be deleted.
    throw new Error(
      "set all of OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY, or none"
    );
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: env.OBJECT_STORAGE_REGION ?? "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

export function isObjectStorageConfigured(): boolean {
  return objectStorageConfig() !== null;
}

export class ObjectStorageError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

const TIMEOUT_MS = 30_000;

let cached: { config: ObjectStorageConfig; client: AwsClient } | null = null;

function storage(): { config: ObjectStorageConfig; client: AwsClient } {
  const config = objectStorageConfig();
  if (!config) throw new ObjectStorageError("object storage is not configured");
  if (!cached || cached.config.endpoint !== config.endpoint) {
    cached = {
      config,
      client: new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: "s3",
        region: config.region,
        retries: 0,
      }),
    };
  }
  return cached;
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function objectUrl(config: ObjectStorageConfig, key: string): string {
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`;
}

/** The object as a streaming response, or null when it does not exist. */
export async function getObject(key: string): Promise<Response | null> {
  const { config, client } = storage();
  const response = await client.fetch(objectUrl(config, key), {
    method: "GET",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ObjectStorageError(`object storage answered ${response.status}`, response.status);
  }
  return response;
}

/** The object's bytes, or null when it does not exist. */
export async function getObjectBytes(key: string): Promise<Buffer | null> {
  const response = await getObject(key);
  if (!response) return null;
  return Buffer.from(await response.arrayBuffer());
}

export async function putObject(
  key: string,
  body: Uint8Array | string,
  contentType: string
): Promise<void> {
  const { config, client } = storage();
  const response = await client.fetch(objectUrl(config, key), {
    method: "PUT",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : Buffer.from(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new ObjectStorageError(`object storage answered ${response.status}`, response.status);
  }
}

/**
 * A link that fetches the object straight from storage for `expiresSeconds`
 * (at most 7 days, S3's limit). `filename` sets the download name.
 */
export async function presignGet(
  key: string,
  expiresSeconds: number,
  filename?: string,
  contentType?: string
): Promise<string> {
  const { config, client } = storage();
  const url = new URL(objectUrl(config, key));
  url.searchParams.set(
    "X-Amz-Expires",
    String(Math.max(1, Math.min(Math.floor(expiresSeconds), 7 * 24 * 3600)))
  );
  if (filename) {
    url.searchParams.set("response-content-disposition", contentDisposition(filename));
  }
  if (contentType) url.searchParams.set("response-content-type", contentType);
  const signed = await client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

/** `attachment; filename=...` with an RFC 5987 UTF-8 copy for non-ASCII names. */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 200) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).slice(0, 600)}`;
}

/** Keys under a prefix (at most `max`). */
export async function listKeys(prefix: string, max = 1000): Promise<string[]> {
  const { config, client } = storage();
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const url = new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", String(Math.min(1000, max - keys.length)));
    if (token) url.searchParams.set("continuation-token", token);
    const response = await client.fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const xml = await response.text();
    if (!response.ok) {
      throw new ObjectStorageError(`object storage answered ${response.status}`, response.status);
    }
    // Element names may carry a namespace prefix (<s3:Key>).
    for (const match of xml.matchAll(/<(?:[\w-]+:)?Key>([^<]*)<\/(?:[\w-]+:)?Key>/g)) {
      keys.push(xmlUnescape(match[1]));
    }
    const truncated = /<(?:[\w-]+:)?IsTruncated>true<\/(?:[\w-]+:)?IsTruncated>/.test(xml);
    const next =
      /<(?:[\w-]+:)?NextContinuationToken>([^<]*)<\/(?:[\w-]+:)?NextContinuationToken>/.exec(xml);
    token = truncated && next ? xmlUnescape(next[1]) : null;
  } while (token && keys.length < max);
  return keys;
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Deletes keys in batches of 1,000 (S3's DeleteObjects limit). */
export async function deleteKeys(keys: string[]): Promise<void> {
  const { config, client } = storage();
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>` +
      batch.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("") +
      `</Delete>`;
    const response = await client.fetch(
      `${config.endpoint}/${encodeURIComponent(config.bucket)}?delete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          // DeleteObjects requires a checksum of the body.
          "content-md5": createHash("md5").update(body).digest("base64"),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
    const text = await response.text();
    if (!response.ok || /<Error>/.test(text)) {
      throw new ObjectStorageError(
        `object storage refused a delete (${response.status})`,
        response.status
      );
    }
  }
}

/** Deletes every object under a request's prefix. */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!OBJECT_PREFIX.test(prefix)) {
    throw new ObjectStorageError("refusing to delete outside a request prefix");
  }
  const keys = await listKeys(prefix, 10_000);
  if (keys.length > 0) await deleteKeys(keys);
  return keys.length;
}
