import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import { DropError, openDropSocket, type DropConnections } from "./connect";

/**
 * SFTP for drops, over a socket from openDropSocket (the egress proxy and
 * the SSRF rules). The server's host key is pinned: the drop stores its
 * SHA-256 fingerprint the first time it connects (shown to the owner), and
 * any other key afterwards fails the connection, as ssh does. Files are
 * written under a temporary name and renamed when complete.
 */

export interface SftpOptions {
  host: string;
  port: number;
  username: string;
  /** A password, or a private key in OpenSSH or PEM form. */
  password?: string | null;
  privateKey?: string | null;
  /** The host key fingerprint (SHA256:base64) to accept; null accepts the first and reports it. */
  hostKey?: string | null;
  /** The drop's connections, which its deadline ends. */
  connections?: DropConnections;
}

const HANDSHAKE_TIMEOUT_MS = 20_000;
/** One SFTP operation (a stat, a file written, a rename) may take this long. */
const OPERATION_TIMEOUT_MS = 120_000;

/** An SFTP operation that fails after OPERATION_TIMEOUT_MS instead of waiting forever. */
function operation<T>(
  what: string,
  run: (done: (error: unknown, value?: T) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DropError(`The server took too long to answer (${what}).`)),
      OPERATION_TIMEOUT_MS
    );
    run((error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as T);
    });
  });
}

/** A host key's fingerprint, as OpenSSH prints it: SHA256: and unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export class SftpSession {
  private constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    /** The fingerprint of the key the server showed. */
    readonly hostKey: string
  ) {}

  static async connect(options: SftpOptions): Promise<SftpSession> {
    const { socket } = await openDropSocket(options.host, options.port, {
      connections: options.connections,
    });
    const client = new Client();
    let seenKey: string | null = null;
    let keyMismatch = false;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", () => resolve());
        client.once("error", reject);
        client.connect({
          sock: socket,
          username: options.username,
          password: options.password ?? undefined,
          privateKey: options.privateKey ?? undefined,
          readyTimeout: HANDSHAKE_TIMEOUT_MS,
          // A server that stops answering ends the connection within 30 s.
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3,
          // No agent, no keyboard prompts: only what the drop holds.
          tryKeyboard: false,
          hostVerifier: (key: Buffer) => {
            seenKey = hostKeyFingerprint(key);
            if (options.hostKey && options.hostKey !== seenKey) {
              keyMismatch = true;
              return false;
            }
            return true;
          },
        });
      });
    } catch (error) {
      client.end();
      socket.destroy();
      if (keyMismatch) {
        throw new DropError(
          `The server's host key changed (it is now ${seenKey}). If that is expected, clear the stored key on the drop.`,
          false
        );
      }
      if (error instanceof DropError) throw error;
      const level = (error as { level?: string }).level;
      if (level === "client-authentication") {
        throw new DropError("The login was refused.", false);
      }
      if (/timed out/i.test((error as Error).message ?? "")) {
        throw new DropError("The server did not answer in time.");
      }
      if (/private key|parse/i.test((error as Error).message ?? "")) {
        throw new DropError("The private key could not be read.", false);
      }
      throw new DropError("The SFTP connection failed.");
    }
    try {
      const sftp = await operation<SFTPWrapper>("starting SFTP", (done) =>
        client.sftp((error, wrapper) => done(error, wrapper))
      );
      return new SftpSession(client, sftp, seenKey!);
    } catch {
      client.end();
      throw new DropError("The server does not offer SFTP.", false);
    }
  }

  /** Throws unless the folder exists. */
  async checkFolder(folder: string): Promise<void> {
    const path = folder || ".";
    const stats = await operation<import("ssh2").Stats | null>("checking the folder", (done) =>
      this.sftp.stat(path, (error, found) => done(null, error ? null : found))
    );
    if (!stats || !stats.isDirectory()) {
      throw new DropError(`The folder ${path} is not there.`, false);
    }
  }

  /** Writes a file under a temporary name, then renames it into place (replacing one of that name). */
  async put(folder: string, name: string, data: Buffer): Promise<void> {
    const target = posix.join(folder || ".", name);
    // Unique, so two uploads of the same name at once cannot take each other's.
    const partial = `${target}.${randomBytes(4).toString("hex")}.part`;
    await operation<void>("writing the file", (done) =>
      this.sftp.writeFile(partial, data, (error) =>
        done(error ? new DropError(`The file could not be written: ${error.message}`) : null)
      )
    );
    const rename = () =>
      operation<void>("renaming the file", (done) => {
        // The OpenSSH extension replaces an existing file in one step.
        const finish = (error: Error | null | undefined) => done(error ?? null);
        if (this.sftp.ext_openssh_rename) this.sftp.ext_openssh_rename(partial, target, finish);
        else this.sftp.rename(partial, target, finish);
      });
    try {
      await rename();
    } catch {
      // A server without the extension will not rename over a file (a retry
      // after an upload that went through): remove the old one first.
      await operation<void>("removing the old file", (done) =>
        this.sftp.unlink(target, () => done(null))
      );
      try {
        await rename();
      } catch (error) {
        throw new DropError(`The file could not be renamed: ${(error as Error).message}`);
      }
    }
  }

  close(): void {
    this.client.end();
  }
}
