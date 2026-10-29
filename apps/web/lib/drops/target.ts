import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import type { FileDropConfig, DropSecret } from "./config";
import { DropConnections, DropError } from "./connect";
import { FtpSession } from "./ftp";
import { s3Put } from "./s3";
import { SftpSession } from "./sftp";

/**
 * One connection to a drop's server, for writing any number of files: an
 * SFTP or FTP session, or (S3) one signed request per file.
 */
export interface DropTarget {
  put(name: string, data: Buffer, contentType: string): Promise<void>;
  close(): Promise<void>;
  /** SFTP: the fingerprint of the host key the server showed. */
  hostKey: string | null;
}

/** The secret as stored: AES-GCM over its JSON, like signing secrets. */
export function encryptDropSecret(secret: DropSecret): Buffer {
  return encryptSigningSecret(JSON.stringify(secret));
}

export function decryptDropSecret(encrypted: Buffer): DropSecret | null {
  try {
    const parsed = JSON.parse(decryptSigningSecret(encrypted)) as DropSecret;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Opens a drop's connection. With `deadlineMs`, every connection the drop
 * makes is ended when it runs out, so a server that answers slowly, or
 * never, fails the drop instead of holding a worker; what was waiting fails
 * with "The drop took too long".
 */
export async function openDropTarget(
  config: FileDropConfig,
  secret: DropSecret,
  deadlineMs?: number
): Promise<DropTarget> {
  const connections = new DropConnections();
  const timer = deadlineMs ? setTimeout(() => connections.abort(), deadlineMs) : null;
  timer?.unref();
  try {
    const target = await openWith(config, secret, connections);
    return {
      ...target,
      put: async (name, data, contentType) => {
        try {
          return await target.put(name, data, contentType);
        } catch (error) {
          throw connections.isAborted ? new DropError("The drop took too long.") : error;
        }
      },
      close: async () => {
        if (timer) clearTimeout(timer);
        await target.close().catch(() => undefined);
        connections.abort();
      },
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    // Whether the deadline ended it, asked before the cleanup ends the rest.
    const timedOut = connections.isAborted;
    connections.abort();
    throw timedOut ? new DropError("The drop took too long.") : error;
  }
}

async function openWith(
  config: FileDropConfig,
  secret: DropSecret,
  connections: DropConnections
): Promise<DropTarget> {
  if (config.protocol === "s3") {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !secret.secretAccessKey) {
      throw new DropError("The drop is missing its storage settings.", false);
    }
    const options = {
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: secret.secretAccessKey,
      tlsFingerprint: config.tlsFingerprint,
      connections,
    };
    return {
      put: (name, data, contentType) =>
        s3Put(options, config.folder ? `${config.folder}/${name}` : name, data, contentType),
      close: async () => {},
      hostKey: null,
    };
  }
  if (!config.host || !config.port || !config.username) {
    throw new DropError("The drop is missing its server settings.", false);
  }
  if (config.protocol === "sftp") {
    const session = await SftpSession.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: secret.password,
      privateKey: secret.privateKey,
      hostKey: config.hostKey,
      connections,
    });
    try {
      await session.checkFolder(config.folder);
    } catch (error) {
      session.close();
      throw error;
    }
    return {
      put: (name, data) => session.put(config.folder, name, data),
      close: async () => session.close(),
      hostKey: session.hostKey,
    };
  }
  const session = await FtpSession.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: secret.password ?? "",
    secure: config.protocol === "ftps",
    tlsFingerprint: config.tlsFingerprint,
    connections,
  });
  try {
    await session.cd(config.folder);
  } catch (error) {
    await session.close();
    throw error;
  }
  return {
    put: (name, data) => session.put(name, data),
    close: () => session.close(),
    hostKey: null,
  };
}

/** The file a connection test writes (and writes again each time). */
export const TEST_FILE_NAME = "webhooks-cc-test.txt";

/**
 * Connects, logs in and writes a small test file, which is what a drop
 * needs to work. Answers the SFTP host key seen, to pin on the drop.
 */
export async function testDropTarget(
  config: FileDropConfig,
  secret: DropSecret
): Promise<{ hostKey: string | null; file: string }> {
  // A test holds a request open: a minute at most.
  const target = await openDropTarget(config, secret, 60_000);
  try {
    await target.put(
      TEST_FILE_NAME,
      Buffer.from(
        `A test file from webhooks.cc, written ${new Date().toISOString()}. You can delete it.\n`
      ),
      "text/plain; charset=utf-8"
    );
  } finally {
    await target.close();
  }
  return {
    hostKey: target.hostKey,
    file: config.folder ? `${config.folder}/${TEST_FILE_NAME}` : TEST_FILE_NAME,
  };
}
