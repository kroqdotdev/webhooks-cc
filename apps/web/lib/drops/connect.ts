import net from "node:net";
import { allowPrivateTargets } from "@/lib/forwarding/config";
import { BLOCKED_PORTS, isBlockedAddress, resolveForwardTarget } from "@/lib/forwarding/target";

/**
 * Connections for file drops (SFTP, FTP, S3). They never leave from the web
 * host: in production every connection goes through the egress proxy on the
 * MX box (FILE_DROP_PROXY_URL, a SOCKS5 listener on the private network,
 * apps/mx-rs/src/egress.rs), which resolves the name itself and refuses
 * private and reserved addresses, so a drop never shows the production IP.
 * Without the proxy, drops are offered only outside production, connecting
 * directly with the forwarding SSRF rules and the address pinned.
 */

export class DropError extends Error {
  /** Worth trying again later (a timeout, a refused connection), or not (bad credentials). */
  retry: boolean;

  constructor(message: string, retry = true) {
    super(message);
    this.name = "DropError";
    this.retry = retry;
  }
}

/** The ports a drop may use: the forwarding list, but SFTP's own port is the point here. */
const DROP_BLOCKED_PORTS = new Set([...BLOCKED_PORTS].filter((port) => port !== 22));

export const CONNECT_TIMEOUT_MS = 15_000;

interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

function proxyConfig(): ProxyConfig | null {
  const raw = process.env.FILE_DROP_PROXY_URL;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DropError("File drops are not set up on this server.");
  }
  if (url.protocol !== "socks5:" || !url.hostname || !url.port) {
    throw new DropError("File drops are not set up on this server.");
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

/** Whether this server can make drops: through the proxy, or directly outside production. */
export function dropsOffered(): boolean {
  if (process.env.FILE_DROP_PROXY_URL) return true;
  return process.env.NODE_ENV !== "production";
}

function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/** Our own hosts never take drops (anyone can make one point anywhere). */
function isOwnHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  const own = ["webhooks.cc", "mailhooks.cc"];
  for (const value of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_MAILHOOKS_URL,
    process.env.NEXT_PUBLIC_WEBHOOK_URL,
  ]) {
    if (!value) continue;
    try {
      own.push(new URL(value).hostname.toLowerCase());
    } catch {
      // Not a URL: nothing to add.
    }
  }
  return own.some((host) => host.includes(".") && (name === host || name.endsWith(`.${host}`)));
}

/**
 * The checks that need no DNS, as a reason to show, or null when the host
 * and port may be used. Run when a drop is saved and again before each
 * connection.
 */
export function dropHostProblem(host: string, port: number): string | null {
  const name = host.trim().replace(/^\[|\]$/g, "");
  if (!name) return "Enter the server's host name.";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a port from 1 to 65535.";
  if (DROP_BLOCKED_PORTS.has(port)) return `Port ${port} is not allowed.`;
  const allowPrivate = allowPrivateTargets();
  if (!allowPrivate && (isLocalName(name) || net.isIP(name) !== 0)) {
    return "Use a public host name, not localhost or an IP address.";
  }
  if (!/^[a-z0-9.:-]+$/i.test(name) || name.length > 253) return "That is not a host name.";
  if (isOwnHost(name)) return "Drops go to your own server, not to webhooks.cc.";
  return null;
}

function withTimeout<T>(promise: Promise<T>, socket: net.Socket, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DropError("The server did not answer in time."));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Reads exactly n bytes at a time from a socket not yet handed to anyone
 * else, in paused mode: what arrives past the handshake (an SSH server's
 * banner comes right behind the proxy's reply) stays in the socket's buffer
 * for whoever reads next, rather than being emitted to no listener.
 */
function reader(socket: net.Socket) {
  return {
    read(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off("readable", attempt);
          socket.off("end", onEnd);
          socket.off("error", onError);
        };
        const attempt = () => {
          const chunk = socket.read(n) as Buffer | null;
          if (chunk === null) return;
          cleanup();
          resolve(chunk);
        };
        const onEnd = () => {
          cleanup();
          reject(new DropError("The file drop proxy closed the connection."));
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.on("readable", attempt);
        socket.on("end", onEnd);
        socket.on("error", onError);
        attempt();
      });
    },
  };
}

const SOCKS_REPLIES: Record<number, string> = {
  2: "The file drop proxy refused that address.",
  3: "The network is unreachable from the file drop proxy.",
  4: "The host is unreachable.",
  5: "The server refused the connection.",
  6: "The connection timed out.",
};

/**
 * A connection a drop made, and the address it reached: an FTP data
 * connection goes to that address, never to the name again (which could
 * resolve elsewhere by then).
 */
export interface DropSocket {
  socket: net.Socket;
  address: string | null;
}

/**
 * Every connection one drop opens, so a deadline can end them all: a server
 * that answers slowly, or never, then fails the drop instead of holding a
 * worker.
 */
export class DropConnections {
  private readonly sockets = new Set<net.Socket>();
  private aborted = false;

  add(socket: net.Socket): void {
    if (this.aborted) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  abort(): void {
    this.aborted = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}

export function addressBytes(host: string): Buffer | null {
  const family = net.isIP(host);
  if (family === 4) return Buffer.from([1, ...host.split(".").map(Number)]);
  if (family === 6) {
    const groups = new net.SocketAddress({ address: host, family: "ipv6" }).address;
    const full = expandV6(groups);
    const out = Buffer.alloc(17);
    out[0] = 4;
    full.forEach((group, i) => out.writeUInt16BE(group, 1 + i * 2));
    return out;
  }
  return null;
}

function expandV6(address: string): number[] {
  // A dotted IPv4 tail (::ffff:203.0.113.5) is two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    address = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ""] = address.split("::");
  const parse = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = address.includes("::") ? parse(tail) : [];
  const zeros = new Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

function readAddress(addressType: number, bytes: Buffer): string | null {
  if (addressType === 1 && bytes.length === 4) return Array.from(bytes).join(".");
  if (addressType === 4 && bytes.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return groups.join(":");
  }
  return null;
}

/**
 * A SOCKS5 CONNECT (RFC 1928) with username and password (RFC 1929), by host
 * name, or by address for a connection that must reach the address another
 * one did. Our egress answers with the address it connected to (not its own
 * bound address), which the FTP client uses for data connections.
 */
async function viaProxy(proxy: ProxyConfig, host: string, port: number): Promise<DropSocket> {
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  socket.setNoDelay(true);
  const handshake = async () => {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const input = reader(socket);
    socket.write(Buffer.from([5, 1, 2]));
    const [version, method] = await input.read(2);
    if (version !== 5 || method !== 2) {
      throw new DropError("The file drop proxy refused to authenticate.", true);
    }
    const user = Buffer.from(proxy.username);
    const pass = Buffer.from(proxy.password);
    socket.write(
      Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass])
    );
    const [, status] = await input.read(2);
    if (status !== 0) throw new DropError("The file drop proxy refused our credentials.", true);

    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    const literal = addressBytes(host);
    const name = Buffer.from(host);
    socket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0]),
        literal ?? Buffer.concat([Buffer.from([3, name.length]), name]),
        portBytes,
      ])
    );
    const [, reply, , addressType] = await input.read(4);
    if (reply !== 0) {
      throw new DropError(SOCKS_REPLIES[reply] ?? "The file drop proxy could not connect.");
    }
    const boundLength = addressType === 1 ? 4 : addressType === 4 ? 16 : (await input.read(1))[0];
    const bound = await input.read(boundLength + 2);
    return { socket, address: readAddress(addressType, bound.subarray(0, boundLength)) };
  };
  try {
    return await withTimeout(handshake(), socket, CONNECT_TIMEOUT_MS);
  } catch (error) {
    socket.destroy();
    throw error instanceof DropError
      ? error
      : new DropError("The file drop proxy could not be reached.");
  }
}

async function direct(host: string, port: number): Promise<DropSocket> {
  const allowPrivate = allowPrivateTargets();
  let addresses;
  try {
    addresses = await resolveForwardTarget(
      new URL(`sftp://${net.isIP(host) === 6 ? `[${host}]` : host}`),
      {
        allowPrivate,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new DropError(
      message.includes("private") ? message : "The host name could not be resolved.",
      !message.includes("private")
    );
  }
  // The name's addresses in turn (four at most), as the proxy does: one that
  // does not answer (IPv6 on a host without it) leaves the next to try.
  let lastError: DropError | null = null;
  for (const target of addresses.slice(0, 4)) {
    if (!allowPrivate && isBlockedAddress(target.address)) {
      throw new DropError("The host name points at a private or reserved address.", false);
    }
    const socket = net.connect({ host: target.address, port, family: target.family });
    socket.setNoDelay(true);
    try {
      return await withTimeout(
        new Promise<DropSocket>((resolve, reject) => {
          socket.once("connect", () => resolve({ socket, address: target.address }));
          socket.once("error", reject);
        }),
        socket,
        CONNECT_TIMEOUT_MS
      );
    } catch (error) {
      socket.destroy();
      if (error instanceof DropError) {
        lastError = error;
        continue;
      }
      const code = (error as { code?: string }).code;
      lastError = new DropError(
        code === "ECONNREFUSED"
          ? "The server refused the connection."
          : "The server could not be reached."
      );
    }
  }
  throw lastError ?? new DropError("The host name could not be resolved.");
}

/**
 * A TCP connection to a drop server's host and port, checked, through the
 * egress proxy when one is set. `reached` is an address an earlier
 * connection of the same drop reached (an FTP data connection), which may be
 * an IP literal; the proxy checks it like any other. Throws DropError with a
 * message for the dashboard.
 */
export async function openDropSocket(
  host: string,
  port: number,
  options: { connections?: DropConnections; reached?: boolean } = {}
): Promise<DropSocket> {
  if (options.connections?.isAborted) throw new DropError("The drop took too long.");
  const name = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  const problem =
    options.reached && net.isIP(name) !== 0
      ? Number.isInteger(port) && port > 0 && port < 65536 && !DROP_BLOCKED_PORTS.has(port)
        ? null
        : `Port ${port} is not allowed.`
      : dropHostProblem(name, port);
  if (problem) throw new DropError(problem, false);
  const proxy = proxyConfig();
  let opened: DropSocket;
  if (proxy) opened = await viaProxy(proxy, name, port);
  else if (process.env.NODE_ENV === "production") {
    throw new DropError("File drops are not set up on this server.");
  } else opened = await direct(name, port);
  options.connections?.add(opened.socket);
  return opened;
}
