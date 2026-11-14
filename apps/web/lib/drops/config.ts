import { createPrivateKey } from "node:crypto";
import { utils as sshUtils } from "ssh2";
import { parseColumns, type SheetsColumn } from "@/lib/integrations/sheets";
import type { Json } from "@/lib/supabase/database";
import { dropHostProblem } from "./connect";
import type { DropFileFormat } from "./files";
import { isAws, s3EndpointProblem } from "./s3";
import { normalizeFingerprint } from "./tls";

/**
 * A file drop's settings (endpoint_destinations.config for format
 * "file_drop"): where to connect and what to write. Nothing secret lives
 * here, since config is returned to the browser; the password, private key
 * or S3 secret key is the destination's drop secret, stored encrypted.
 */

export type DropProtocol = "sftp" | "ftp" | "ftps" | "s3";

export interface FileDropConfig {
  protocol: DropProtocol;
  /** SFTP and FTP. */
  host: string | null;
  port: number | null;
  username: string | null;
  /** The folder files go to (SFTP, FTP), or the key prefix (S3); "" is the home folder or bucket root. */
  folder: string;
  /** SFTP: the host key fingerprint, stored on the first connection. */
  hostKey: string | null;
  /** FTPS and S3: a self-signed certificate's SHA-256 fingerprint to accept. */
  tlsFingerprint: string | null;
  /** S3. */
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  /** What each file holds. */
  file: DropFileFormat;
  rows: "email" | "line_items";
  /** CSV and XML: the columns, as for a Google Sheets destination. */
  columns: SheetsColumn[];
  /** Put before each file's name. */
  prefix: string;
  /** One file per batch (what arrived during the destination's delay) rather than per request. */
  batch: boolean;
}

/** The secret a drop needs, as it is stored (encrypted JSON). */
export interface DropSecret {
  password?: string;
  privateKey?: string;
  secretAccessKey?: string;
}

const DEFAULT_PORTS: Record<Exclude<DropProtocol, "s3">, number> = { sftp: 22, ftp: 21, ftps: 21 };
const MAX_SECRET_CHARS = 16 * 1024;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** A folder or key prefix: relative, slash-separated, no "..", no control characters. */
function cleanFolder(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 512) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

/** Checks a config as the API receives it; the config, or what is wrong. */
export function parseFileDropConfig(
  value: unknown,
  kinds: { http: boolean; email: boolean }
): FileDropConfig | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "config must say where the files go and what they hold.";
  }
  const config = value as Record<string, unknown>;
  const protocol = config.protocol;
  if (protocol !== "sftp" && protocol !== "ftp" && protocol !== "ftps" && protocol !== "s3") {
    return 'config.protocol is "sftp", "ftp", "ftps" or "s3".';
  }
  const file = config.file ?? "csv";
  if (file !== "csv" && file !== "json" && file !== "xml") {
    return 'config.file is "csv", "json" or "xml".';
  }
  const rows = config.rows ?? "email";
  if (rows !== "email" && rows !== "line_items") return 'config.rows is "email" or "line_items".';
  let columns: SheetsColumn[] = [];
  if (file !== "json") {
    const parsed = parseColumns(config.columns, kinds, rows, "config.columns");
    if (typeof parsed === "string") return parsed;
    columns = parsed;
  }
  const folder = cleanFolder(config.folder);
  if (folder === null) return "config.folder is a relative path without .. (or empty).";
  if (
    config.prefix !== undefined &&
    (typeof config.prefix !== "string" || config.prefix.length > 60)
  ) {
    return "config.prefix is text of at most 60 characters.";
  }
  if (config.batch !== undefined && typeof config.batch !== "boolean") {
    return "config.batch is true or false.";
  }
  const tlsFingerprint =
    config.tlsFingerprint === undefined ||
    config.tlsFingerprint === null ||
    config.tlsFingerprint === ""
      ? null
      : normalizeFingerprint(String(config.tlsFingerprint));
  if (config.tlsFingerprint && !tlsFingerprint) {
    return "config.tlsFingerprint is a SHA-256 fingerprint (64 hex digits).";
  }
  const common = {
    folder,
    file: file as DropFileFormat,
    rows: rows as "email" | "line_items",
    columns,
    prefix: typeof config.prefix === "string" ? config.prefix : "",
    batch: config.batch === true,
    tlsFingerprint: protocol === "ftps" || protocol === "s3" ? tlsFingerprint : null,
  };

  if (protocol === "s3") {
    const endpoint = text(config.endpoint, 300);
    if (!endpoint) return "config.endpoint is the storage endpoint's URL.";
    const problem = s3EndpointProblem(endpoint);
    if (problem) return problem;
    const host = new URL(endpoint).hostname;
    const hostProblem = dropHostProblem(host, Number(new URL(endpoint).port || 443));
    if (hostProblem) return hostProblem;
    const region = text(config.region, 64) ?? "us-east-1";
    if (!/^[a-z0-9-]+$/i.test(region)) return "config.region is a region name, like eu-central-1.";
    const bucket = text(config.bucket, 63);
    if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      return "config.bucket is a bucket name: lower-case letters, digits, dots and dashes.";
    }
    // On AWS the bucket is part of the host name, and AWS's certificate
    // covers one label there: a name with dots fails every TLS check unless
    // the certificate is pinned instead.
    if (bucket.includes(".") && isAws(host) && !tlsFingerprint) {
      return "An AWS bucket with dots in its name cannot be reached over https: use one without dots, or pin the certificate.";
    }
    const accessKeyId = text(config.accessKeyId, 128);
    if (!accessKeyId || !/^[\x21-\x7e]+$/.test(accessKeyId)) {
      return "config.accessKeyId is the storage's access key id.";
    }
    return {
      ...common,
      protocol,
      host: null,
      port: null,
      username: null,
      hostKey: null,
      endpoint: new URL(endpoint).origin,
      region,
      bucket,
      accessKeyId,
    };
  }

  const host = text(config.host, 253)?.toLowerCase().replace(/\.$/, "") ?? null;
  if (!host) return "config.host is the server's host name.";
  const port =
    config.port === undefined || config.port === null ? DEFAULT_PORTS[protocol] : config.port;
  if (typeof port !== "number") return "config.port is a number.";
  const hostProblem = dropHostProblem(host, port);
  if (hostProblem) return hostProblem;
  const username = text(config.username, 128);
  // eslint-disable-next-line no-control-regex
  if (!username || /[\r\n\u0000]/.test(username)) return "config.username is the login name.";
  const hostKey =
    protocol === "sftp" &&
    typeof config.hostKey === "string" &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(config.hostKey)
      ? config.hostKey
      : null;
  return {
    ...common,
    protocol,
    host,
    port,
    username,
    hostKey,
    endpoint: null,
    region: null,
    bucket: null,
    accessKeyId: null,
  };
}

/** A stored config, or null when it is missing or malformed. */
export function storedFileDropConfig(value: Json | null | undefined): FileDropConfig | null {
  const parsed = parseFileDropConfig(value, { http: true, email: true });
  return typeof parsed === "string" ? null : parsed;
}

/** The address shown for a drop (the destination's url column): never a secret. */
export function dropUrl(config: FileDropConfig): string {
  if (config.protocol === "s3") {
    const host = config.endpoint ? new URL(config.endpoint).host : "";
    return `s3://${config.bucket}/${config.folder}`.replace(/\/$/, "") + (host ? ` (${host})` : "");
  }
  const port =
    config.port && config.port !== DEFAULT_PORTS[config.protocol] ? `:${config.port}` : "";
  return `${config.protocol}://${config.host}${port}/${config.folder}`;
}

/**
 * The secret as the API receives it, for a protocol: { password } (FTP,
 * SFTP), { privateKey } or { password } (SFTP), { secretAccessKey } (S3).
 */
export function parseDropSecret(value: unknown, protocol: DropProtocol): DropSecret | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "dropSecret is an object: { password }, { privateKey } or { secretAccessKey }.";
  }
  const input = value as Record<string, unknown>;
  const secret: DropSecret = {};
  for (const key of ["password", "privateKey", "secretAccessKey"] as const) {
    const item = input[key];
    if (item === undefined || item === null || item === "") continue;
    if (typeof item !== "string" || item.length > MAX_SECRET_CHARS)
      return `dropSecret.${key} is too long.`;
    secret[key] = item;
  }
  if (protocol === "s3") {
    if (!secret.secretAccessKey) return "dropSecret.secretAccessKey is the storage's secret key.";
    return { secretAccessKey: secret.secretAccessKey };
  }
  if (protocol === "sftp") {
    if (!secret.password && !secret.privateKey)
      return "dropSecret needs a password or a privateKey.";
    let privateKey: string | undefined;
    if (secret.privateKey) {
      const key = usablePrivateKey(secret.privateKey);
      if (typeof key !== "string") return key.problem;
      privateKey = key;
    }
    return { password: secret.password, privateKey };
  }
  if (!secret.password) return "dropSecret.password is the FTP password.";
  return { password: secret.password };
}

const NEW_KEY_ADVICE =
  'Make a new key for the drop (ssh-keygen -t ed25519 -N "" -f drop_key), add drop_key.pub to the server\'s authorized_keys, and send drop_key.';

/**
 * A private key as drops will use it, or why it cannot be. SFTP connects
 * with ssh2 and no passphrase, so the key is checked the same way here, when
 * it is saved, rather than failing at the first drop. ssh2 reads OpenSSH
 * keys and PEM RSA and EC keys; an RSA or EC key in PKCS#8 form (`BEGIN
 * PRIVATE KEY`) is converted to PEM here and stored that way. Each line is
 * trimmed, and a key whose line breaks became spaces is put back on its lines.
 */
function usablePrivateKey(value: string): string | { problem: string } {
  let key =
    value
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      .join("\n")
      .trim() + "\n";
  // One line only: a key whose line breaks became spaces.
  const oneLine = /^(-----BEGIN [A-Z0-9 ]+-----) *([^\n]*?) *(-----END [A-Z0-9 ]+-----)\n$/.exec(
    key
  );
  if (oneLine) key = [oneLine[1], ...oneLine[2].split(/\s+/), oneLine[3]].join("\n") + "\n";

  const encrypted = {
    problem:
      'dropSecret.privateKey is protected by a passphrase, which drops cannot use. Remove it from a copy of the key (chmod 600 <copy>, then ssh-keygen -p -N "" -f <copy>) and send the copy.',
  };
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/.test(key)) return encrypted;

  if (key.startsWith("-----BEGIN PRIVATE KEY-----")) {
    const converted = convertPkcs8(key);
    if (converted === null) {
      return {
        problem: `dropSecret.privateKey is a PKCS#8 key of a kind drops cannot use (only RSA and EC keys are converted). ${NEW_KEY_ADVICE}`,
      };
    }
    key = converted;
  }

  const parsed = sshUtils.parseKey(key);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first instanceof Error) {
    if (/passphrase|encrypted/i.test(first.message)) return encrypted;
    if (oneLine) {
      return {
        problem:
          "dropSecret.privateKey arrived on one line: its line breaks were lost. Send the key file as it is, a line break after each line.",
      };
    }
    return {
      problem: `dropSecret.privateKey is not a key drops can use: they take a whole OpenSSH key (-----BEGIN OPENSSH PRIVATE KEY-----), or an RSA or EC key in PEM or PKCS#8 form, without a passphrase. ${NEW_KEY_ADVICE}`,
    };
  }
  if (!first || !first.isPrivateKey()) {
    return { problem: "dropSecret.privateKey is a public key; send the private one." };
  }
  return key;
}

/**
 * A PKCS#8 RSA or EC key as PEM (PKCS#1 or SEC1), which ssh2 reads; null
 * for any other kind (an Ed25519 key among them) or a key that does not parse.
 */
function convertPkcs8(key: string): string | null {
  try {
    const parsed = createPrivateKey(key);
    if (parsed.asymmetricKeyType === "rsa") {
      return parsed.export({ type: "pkcs1", format: "pem" }).toString();
    }
    if (parsed.asymmetricKeyType === "ec") {
      return parsed.export({ type: "sec1", format: "pem" }).toString();
    }
    return null;
  } catch {
    return null;
  }
}

/** Whether a stored secret suits a protocol (a protocol change needs a new one). */
export function secretFits(secret: DropSecret | null, protocol: DropProtocol): boolean {
  if (!secret) return false;
  if (protocol === "s3") return !!secret.secretAccessKey;
  if (protocol === "sftp") return !!(secret.password || secret.privateKey);
  return !!secret.password;
}
