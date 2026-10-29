import type net from "node:net";
import { randomBytes } from "node:crypto";
import tls from "node:tls";
import { CONNECT_TIMEOUT_MS, DropError, openDropSocket, type DropConnections } from "./connect";
import { secureSocket } from "./tls";

/**
 * A small FTP client for drops: log in, optionally upgrade to TLS (explicit
 * FTPS, AUTH TLS with protected data), and store files. It is our own so
 * that every connection, the data connections too, goes through
 * openDropSocket (the egress proxy and the SSRF rules); a data connection
 * always goes to the control connection's host, never to the address a
 * PASV reply names (which could point anywhere, the FTP bounce).
 *
 * Files are stored under a temporary name and renamed when complete, so a
 * system watching the folder never picks up half a file.
 */

export interface FtpOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Explicit FTPS (AUTH TLS, PROT P); plain FTP sends the password in the clear. */
  secure: boolean;
  /** SHA-256 fingerprint of a self-signed certificate to accept (hex, colons optional). */
  tlsFingerprint?: string | null;
  /** The drop's connections, which its deadline ends. */
  connections?: DropConnections;
}

interface Reply {
  code: number;
  text: string;
}

const COMMAND_TIMEOUT_MS = 20_000;
/** A file's upload over the data connection may take this long. */
const UPLOAD_TIMEOUT_MS = 120_000;
/** A server that sends more than this without a reply is not an FTP server we talk to. */
const MAX_LINE_CHARS = 8 * 1024;
const MAX_REPLY_LINES = 200;

class Control {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private lines: string[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  private closedError: Error | null = null;
  private readonly onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    let start = 0;
    let index;
    // Only the new text is searched; the partial line before it has no newline.
    while ((index = text.indexOf("\n", start)) >= 0) {
      this.lines.push((this.buffer + text.slice(start, index)).replace(/\r$/, ""));
      this.buffer = "";
      start = index + 1;
    }
    this.buffer += text.slice(start);
    if (this.buffer.length > MAX_LINE_CHARS || this.lines.length > MAX_REPLY_LINES) {
      this.fail(new DropError("The FTP server sent more than a reply.", false));
      return;
    }
    this.flush();
  };
  private fail(error: DropError) {
    this.closedError = error;
    this.waiter?.reject(error);
    this.waiter = null;
    this.socket.destroy();
  }

  private readonly onClose = () => {
    this.closedError = new DropError("The FTP server closed the connection.");
    this.waiter?.reject(this.closedError);
    this.waiter = null;
  };
  private readonly onError = (error: Error) => {
    this.closedError =
      error instanceof DropError ? error : new DropError("The FTP connection failed.");
    this.waiter?.reject(this.closedError);
    this.waiter = null;
  };

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach();
  }

  private attach() {
    this.socket.on("data", this.onData);
    this.socket.on("close", this.onClose);
    this.socket.on("error", this.onError);
  }

  private detach() {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("error", this.onError);
  }

  /** A complete reply from the lines read so far: "123 text", or "123-" lines up to "123 ". */
  private takeReply(): Reply | null {
    // Lines that do not start a reply are skipped (a loop: there can be many).
    while (this.lines.length > 0 && !/^\d{3}[ -]/.test(this.lines[0])) this.lines.shift();
    if (this.lines.length === 0) return null;
    const first = this.lines[0];
    const match = /^(\d{3})([ -])/.exec(first)!;
    if (match[2] === " ") {
      this.lines.shift();
      return { code: Number(match[1]), text: first.slice(4) };
    }
    const end = this.lines.findIndex((line, i) => i > 0 && line.startsWith(`${match[1]} `));
    if (end < 0) return null;
    const text = this.lines
      .slice(0, end + 1)
      .map((line) => line.slice(4))
      .join("\n");
    this.lines.splice(0, end + 1);
    return { code: Number(match[1]), text };
  }

  private flush() {
    if (!this.waiter) return;
    const reply = this.takeReply();
    if (!reply) return;
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(reply);
  }

  read(): Promise<Reply> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new DropError("The FTP server stopped answering."));
      }, COMMAND_TIMEOUT_MS);
      this.waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.flush();
    });
  }

  async send(command: string): Promise<Reply> {
    if (/[\r\n]/.test(command)) throw new DropError("A name contains a line break.", false);
    this.socket.write(`${command}\r\n`);
    return this.read();
  }

  /** Switches the connection to TLS after AUTH TLS was accepted. */
  async upgrade(host: string, fingerprint: string | null | undefined): Promise<tls.TLSSocket> {
    // Anything that came after the 234 in the clear would be read as an
    // answer to what is sent under TLS: refuse it.
    if (this.buffer || this.lines.length > 0) {
      this.close();
      throw new DropError("The FTP server sent more than it should before TLS.", false);
    }
    this.detach();
    const secure = await secureSocket(this.socket as net.Socket, host, fingerprint);
    this.socket = secure;
    this.attach();
    return secure;
  }

  get tlsSocket(): tls.TLSSocket | null {
    return this.socket instanceof tls.TLSSocket ? this.socket : null;
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

function expect(reply: Reply, codes: number[], what: string, retry = true): Reply {
  if (codes.includes(reply.code)) return reply;
  // The server's own words, cut short: they help and never hold our secrets.
  const said = reply.text.replace(/\s+/g, " ").slice(0, 160);
  throw new DropError(`${what} (the server said ${reply.code} ${said})`, retry);
}

/** A connected, logged-in FTP session. */
export class FtpSession {
  private constructor(
    private readonly control: Control,
    private readonly options: FtpOptions
  ) {}

  /** The address the control connection reached; data connections go there too. */
  private address: string | null = null;

  static async connect(options: FtpOptions): Promise<FtpSession> {
    const { socket, address } = await openDropSocket(options.host, options.port, {
      connections: options.connections,
    });
    const control = new Control(socket);
    const session = new FtpSession(control, options);
    session.address = address;
    try {
      expect(await control.read(), [220], "The FTP server did not greet us");
      if (options.secure) {
        expect(await control.send("AUTH TLS"), [234], "The server does not offer FTPS", false);
        await control.upgrade(options.host, options.tlsFingerprint);
      }
      const user = await control.send(`USER ${options.username}`);
      if (user.code === 331) {
        expect(
          await control.send(`PASS ${options.password}`),
          [230, 202],
          "The login was refused",
          false
        );
      } else {
        expect(user, [230], "The login was refused", false);
      }
      if (options.secure) {
        expect(await control.send("PBSZ 0"), [200], "The server refused protected data");
        expect(await control.send("PROT P"), [200], "The server refused protected data");
      }
      expect(await control.send("TYPE I"), [200], "The server refused binary mode");
      return session;
    } catch (error) {
      control.close();
      throw error;
    }
  }

  /** Changes to a directory, which must exist. */
  async cd(directory: string): Promise<void> {
    if (!directory || directory === ".") return;
    expect(
      await this.control.send(`CWD ${directory}`),
      [250],
      `The folder ${directory} is not there`,
      false
    );
  }

  /** A passive data connection (TCP only; TLS starts after the transfer command). */
  private async dataConnection(): Promise<net.Socket> {
    let port: number | null = null;
    const epsv = await this.control.send("EPSV");
    if (epsv.code === 229) {
      const match = /\(\|\|\|(\d+)\|\)/.exec(epsv.text);
      if (match) port = Number(match[1]);
    }
    if (port === null) {
      const pasv = expect(
        await this.control.send("PASV"),
        [227],
        "The server refused a data connection"
      );
      const numbers = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
      if (!numbers) throw new DropError("The server's data connection reply was not understood.");
      // Only the port: the address is the control connection's host.
      port = Number(numbers[5]) * 256 + Number(numbers[6]);
    }
    // The control connection's address, not its name again: a name can
    // resolve elsewhere by now, and the data would go there.
    const opened = this.address
      ? await openDropSocket(this.address, port, {
          connections: this.options.connections,
          reached: true,
        })
      : await openDropSocket(this.options.host, port, { connections: this.options.connections });
    return opened.socket;
  }

  /** Stores a file under a temporary name, then renames it into place. */
  async put(name: string, data: Buffer): Promise<void> {
    // Unique, so two uploads of the same name at once cannot take each other's.
    const partial = `${name}.${randomBytes(4).toString("hex")}.part`;
    const raw = await this.dataConnection();
    let socket: net.Socket | tls.TLSSocket = raw;
    try {
      // The command goes first: a server starts TLS on the data connection
      // only once it knows the transfer (vsftpd), so the handshake and the
      // reply are awaited together.
      const reply = this.control.send(`STOR ${partial}`);
      const control = this.control.tlsSocket;
      if (this.options.secure && control) {
        // Servers that check the data connection resumes the control
        // session need it passed on.
        const [secure, started] = await Promise.all([
          secureSocket(raw, this.options.host, this.options.tlsFingerprint, control.getSession()),
          reply,
        ]);
        socket = secure;
        expect(started, [150, 125], "The server would not take the file", started.code < 500);
      } else {
        expect(await reply, [150, 125], "The server would not take the file");
      }
    } catch (error) {
      raw.destroy();
      throw error;
    }
    const done = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.once("error", () => resolve());
    });
    const uploadTimer = setTimeout(() => socket.destroy(), UPLOAD_TIMEOUT_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.end(data, () => resolve());
        socket.once("error", () => reject(new DropError("The data connection broke.")));
        socket.once("close", () => resolve());
      });
      const timer = setTimeout(() => socket.destroy(), CONNECT_TIMEOUT_MS);
      await done;
      clearTimeout(timer);
    } finally {
      clearTimeout(uploadTimer);
    }
    expect(await this.control.read(), [226, 250], "The upload did not complete");
    expect(await this.control.send(`RNFR ${partial}`), [350], "The file could not be renamed");
    const renamed = await this.control.send(`RNTO ${name}`);
    if (renamed.code === 250) return;
    // A file of that name is there (a retry after an upload that went
    // through): servers that do not replace on rename need it removed first.
    await this.control.send(`DELE ${name}`);
    expect(await this.control.send(`RNFR ${partial}`), [350], "The file could not be renamed");
    expect(await this.control.send(`RNTO ${name}`), [250], "The file could not be renamed");
  }

  async close(): Promise<void> {
    try {
      await this.control.send("QUIT");
    } catch {
      // Closing anyway.
    }
    this.control.close();
  }
}
