import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type net from "node:net";
import tls from "node:tls";
import { DropError } from "./connect";

/**
 * TLS for drops (FTPS, S3): the server's certificate is checked as usual,
 * unless the drop names the SHA-256 fingerprint of a self-signed one, which
 * is then the only certificate accepted. Node skips checkServerIdentity when
 * the chain itself does not verify, so a pinned certificate is compared
 * after the handshake instead.
 */

/** A fingerprint as stored: upper-case hex pairs joined by colons, as Node prints them. */
export function normalizeFingerprint(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value
    .replace(/^sha256:/i, "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();
  if (hex.length !== 64) return null;
  return hex.match(/../g)!.join(":");
}

/** The SHA-256 fingerprint of a certificate in DER form. */
export function certificateFingerprint(raw: Buffer): string {
  return normalizeFingerprint(createHash("sha256").update(raw).digest("hex"))!;
}

function handshakeError(error: unknown): DropError {
  if (error instanceof DropError) return error;
  const code = (error as { code?: string }).code ?? "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME/.test(code)) {
    return new DropError(
      "The server's certificate is not trusted. If it is self-signed, add its fingerprint to the drop.",
      false
    );
  }
  return new DropError("The TLS handshake with the server failed.");
}

/**
 * TLS over a connected socket. With a fingerprint, only that certificate is
 * accepted; without, the usual chain and host name checks apply.
 */
export async function secureSocket(
  socket: net.Socket,
  host: string,
  fingerprint: string | null | undefined,
  session?: Buffer
): Promise<tls.TLSSocket> {
  const pinned = normalizeFingerprint(fingerprint);
  const secure = tls.connect({
    socket,
    // SNI carries names only; an address is checked against the certificate as it is.
    ...(isIP(host) ? { host } : { servername: host }),
    rejectUnauthorized: pinned === null,
    ...(session ? { session } : {}),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
  } catch (error) {
    secure.destroy();
    throw handshakeError(error);
  }
  // A resumed session (an FTPS data connection) carries no certificate; it
  // resumes only with the server whose certificate the first one checked.
  if (pinned && !secure.isSessionReused()) {
    const raw = secure.getPeerCertificate(false)?.raw;
    const actual = raw ? certificateFingerprint(raw) : null;
    if (actual !== pinned) {
      secure.destroy();
      throw new DropError(
        `The server's certificate does not match the fingerprint on the drop (it is ${actual ?? "unknown"}).`,
        false
      );
    }
  }
  return secure;
}
