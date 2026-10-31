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
/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/**
 * Whether an SSH connection has closed, and the operations waiting on it:
 * ssh2 never calls back an operation started on (or caught by) a closed
 * connection, so they are failed here at once instead of each waiting out
 * its timer.
 */
class Liveness {
  closed = false;
  private readonly waiting = new Set<(error: Error) => void>();

  watch(client: Client) {
    const close = () => {
      this.closed = true;
      for (const fail of this.waiting) fail(new DropError("The SFTP connection closed."));
      this.waiting.clear();
    };
    client.once("close", close);
    client.once("end", close);
  }

  /** An SFTP operation that fails when the connection closes, or after OPERATION_TIMEOUT_MS. */
  operation<T>(what: string, run: (done: (error: unknown, value?: T) => void) => void): Promise<T> {
    if (this.closed) return Promise.reject(new DropError("The SFTP connection closed."));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(fail);
        reject(new DropError(`The server took too long to answer (${what}).`));
      }, OPERATION_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiting.add(fail);
      run((error, value) => {
        clearTimeout(timer);
        this.waiting.delete(fail);
        if (error) reject(error);
        else resolve(value as T);
      });
    });
  }
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
    readonly hostKey: string,
    private readonly live: Liveness
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
      const live = new Liveness();
      live.watch(client);
      const sftp = await live.operation<SFTPWrapper>("starting SFTP", (done) =>
        client.sftp((error, wrapper) => done(error, wrapper))
      );
      return new SftpSession(client, sftp, seenKey!, live);
    } catch {
      client.end();
      throw new DropError("The server does not offer SFTP.", false);
    }
  }

  /** Throws unless the folder exists; only a missing or unreadable folder is for good. */
  async checkFolder(folder: string): Promise<void> {
    const path = folder || ".";
    const stats = await this.live.operation<import("ssh2").Stats>("checking the folder", (done) =>
      this.sftp.stat(path, (error, found) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        if (code === SFTP_NO_SUCH_FILE) {
          done(new DropError(`The folder ${path} is not there.`, false));
        } else if (code === SFTP_PERMISSION_DENIED) {
          done(new DropError(`The login may not read the folder ${path}.`, false));
        } else if (error) {
          done(new DropError(`The folder ${path} could not be checked: ${error.message}`));
        } else {
          done(null, found);
        }
      })
    );
    if (!stats.isDirectory()) {
      throw new DropError(`The folder ${path} is not there.`, false);
    }
  }

  /** Writes a file under a temporary name, then renames it into place (replacing one of that name). */
  async put(folder: string, name: string, data: Buffer): Promise<void> {
    const target = posix.join(folder || ".", name);
    // Unique, so two uploads of the same name at once cannot take each other's.
    const partial = `${target}.${randomBytes(4).toString("hex")}.part`;
    await this.live.operation<void>("writing the file", (done) =>
      this.sftp.writeFile(partial, data, (error) =>
        done(error ? new DropError(`The file could not be written: ${error.message}`) : null)
      )
    );
    const renamed = (error: unknown) =>
      new DropError(`The file could not be renamed: ${(error as Error).message}`);
    // The OpenSSH extension replaces a file of that name in one step. ssh2
    // throws at once when the server does not offer it.
    let extension = true;
    try {
      await this.live.operation<void>("renaming the file", (done) => {
        try {
          this.sftp.ext_openssh_rename(partial, target, (error) => done(error ?? null));
        } catch {
          extension = false;
          done(null);
        }
      });
    } catch (error) {
      throw renamed(error);
    }
    if (extension) return;
    // A plain rename does not replace a file (there is one after an upload
    // that went through and is tried again): the old one is moved aside
    // first, and removed only once the new one is in place.
    try {
      await this.rename(partial, target);
      return;
    } catch {
      // The name is taken.
    }
    const aside = `${target}.${randomBytes(4).toString("hex")}.old`;
    try {
      await this.rename(target, aside);
    } catch (error) {
      throw renamed(error);
    }
    try {
      await this.rename(partial, target);
    } catch (error) {
      await this.rename(aside, target).catch(() => undefined);
      throw renamed(error);
    }
    await this.live
      .operation<void>("removing the old file", (done) =>
        this.sftp.unlink(aside, (error) => done(error ?? null))
      )
      .catch(() => undefined);
  }

  private rename(from: string, to: string): Promise<void> {
    return this.live.operation<void>("renaming the file", (done) =>
      this.sftp.rename(from, to, (error) => done(error ?? null))
    );
  }

  close(): void {
    this.client.end();
  }
}
