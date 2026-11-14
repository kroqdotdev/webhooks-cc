import { generateKeyPairSync } from "node:crypto";
import { utils as sshUtils } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { parseDropSecret, parseFileDropConfig } from "./config";

vi.mock("@/lib/forwarding/config", () => ({ allowPrivateTargets: () => false }));

const kinds = { http: false, email: true };
const s3 = (fields: Record<string, unknown>) => ({
  protocol: "s3",
  file: "json",
  endpoint: "https://s3.eu-central-1.amazonaws.com",
  region: "eu-central-1",
  bucket: "acme-orders",
  accessKeyId: "AKIAEXAMPLE",
  ...fields,
});

describe("parseFileDropConfig, S3", () => {
  it("takes an AWS bucket without dots", () => {
    expect(typeof parseFileDropConfig(s3({}), kinds)).toBe("object");
  });

  it("refuses an AWS bucket with dots, whose host name no certificate covers", () => {
    expect(parseFileDropConfig(s3({ bucket: "orders.acme.example" }), kinds)).toMatch(
      /cannot be reached over https/
    );
  });

  it("takes a dotted AWS bucket when the certificate is pinned, and dots elsewhere", () => {
    const pinned = parseFileDropConfig(
      s3({ bucket: "orders.acme.example", tlsFingerprint: "ab".repeat(32) }),
      kinds
    );
    expect(typeof pinned).toBe("object");
    const elsewhere = parseFileDropConfig(
      s3({ bucket: "orders.acme.example", endpoint: "https://storage.acme.example" }),
      kinds
    );
    expect(typeof elsewhere).toBe("object");
  });
});

describe("parseDropSecret, SFTP keys", () => {
  // Throwaway keys made for each run, never real ones.
  const openssh = sshUtils.generateKeyPairSync("ed25519");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const sftp = (privateKey: string) => parseDropSecret({ privateKey }, "sftp");
  const keyOf = (privateKey: string) => {
    const parsed = sftp(privateKey);
    return typeof parsed === "string" ? parsed : parsed.privateKey;
  };

  it("takes OpenSSH keys and PEM RSA and EC keys", () => {
    for (const key of [
      openssh.private,
      rsa.export({ type: "pkcs1", format: "pem" }).toString(),
      ec.export({ type: "sec1", format: "pem" }).toString(),
    ]) {
      expect(keyOf(key)).toBe(key.trim() + "\n");
    }
  });

  it("trims indented lines and keeps the key", () => {
    const indented = openssh.private
      .trim()
      .split("\n")
      .map((line) => `   ${line}\r`)
      .join("\n");
    expect(keyOf(indented)).toBe(openssh.private.trim() + "\n");
  });

  it("asks for the passphrase to be removed from an encrypted key", () => {
    const encrypted = sshUtils.generateKeyPairSync("ed25519", {
      passphrase: "made-up",
      cipher: "aes256-ctr",
      rounds: 2,
    }).private;
    for (const key of [
      encrypted,
      rsa
        .export({ type: "pkcs1", format: "pem", cipher: "aes-128-cbc", passphrase: "made-up" })
        .toString(),
      rsa
        .export({ type: "pkcs8", format: "pem", cipher: "aes-128-cbc", passphrase: "made-up" })
        .toString(),
    ]) {
      expect(sftp(key)).toMatch(/protected by a passphrase.*ssh-keygen -p -N "" -f/);
    }
  });

  it("asks for a PKCS#8 key to be rewritten", () => {
    const pkcs8 = rsa.export({ type: "pkcs8", format: "pem" }).toString();
    expect(sftp(pkcs8)).toMatch(/not PKCS#8.*ssh-keygen -p -N "" -f/);
  });

  it("refuses a key cut off, made up or public", () => {
    expect(sftp("-----BEGIN OPENSSH PRIVATE KEY-----")).toMatch(/not a key drops can use/);
    expect(
      sftp("-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up\n-----END OPENSSH PRIVATE KEY-----")
    ).toMatch(/not a key drops can use/);
    expect(sftp(openssh.private.split("\n").slice(0, 3).join("\n"))).toMatch(
      /not a key drops can use/
    );
    expect(sftp(openssh.public)).toMatch(/public key/);
  });

  it("still takes a password", () => {
    expect(parseDropSecret({ password: "hunter2" }, "sftp")).toEqual({
      password: "hunter2",
      privateKey: undefined,
    });
  });
});
