import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import { DropError, openDropSocket } from "./connect";

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
}

const HANDSHAKE_TIMEOUT_MS = 20_000;

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
    const socket = await openDropSocket(options.host, options.port);
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
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
      });
      return new SftpSession(client, sftp, seenKey!);
    } catch {
      client.end();
      throw new DropError("The server does not offer SFTP.", false);
    }
  }

  /** Throws unless the folder exists. */
  async checkFolder(folder: string): Promise<void> {
    const path = folder || ".";
    await new Promise<void>((resolve, reject) => {
      this.sftp.stat(path, (error, stats) => {
        if (error || !stats.isDirectory()) {
          reject(new DropError(`The folder ${path} is not there.`, false));
        } else {
          resolve();
        }
      });
    });
  }

  /** Writes a file under a temporary name, then renames it into place (replacing one of that name). */
  async put(folder: string, name: string, data: Buffer): Promise<void> {
    const target = posix.join(folder || ".", name);
    // Unique, so two uploads of the same name at once cannot take each other's.
    const partial = `${target}.${randomBytes(4).toString("hex")}.part`;
    await new Promise<void>((resolve, reject) => {
      this.sftp.writeFile(partial, data, (error) =>
        error ? reject(new DropError(`The file could not be written: ${error.message}`)) : resolve()
      );
    });
    const rename = () =>
      new Promise<void>((resolve, reject) => {
        // The OpenSSH extension replaces an existing file in one step.
        const done = (error: Error | null | undefined) => (error ? reject(error) : resolve());
        if (this.sftp.ext_openssh_rename) this.sftp.ext_openssh_rename(partial, target, done);
        else this.sftp.rename(partial, target, done);
      });
    try {
      await rename();
    } catch {
      // A server without the extension will not rename over a file (a retry
      // after an upload that went through): remove the old one first.
      await new Promise<void>((resolve) => this.sftp.unlink(target, () => resolve()));
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
