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
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
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
      expect(sftp(key)).toMatch(
        /protected by a passphrase.*chmod 600 <copy>, then ssh-keygen -p -N "" -f <copy>/
      );
    }
  });

  it("converts PKCS#8 RSA and EC keys to PEM", () => {
    const fromRsa = keyOf(rsa.export({ type: "pkcs8", format: "pem" }).toString());
    expect(fromRsa).toBe(rsa.export({ type: "pkcs1", format: "pem" }).toString());
    const fromEc = keyOf(ec.export({ type: "pkcs8", format: "pem" }).toString());
    expect(fromEc).toBe(ec.export({ type: "sec1", format: "pem" }).toString());
    for (const key of [fromRsa, fromEc]) {
      const parsed = sshUtils.parseKey(key ?? "");
      expect(parsed instanceof Error).toBe(false);
    }
  });

  it("asks for a new key for an Ed25519 PKCS#8 key", () => {
    const ed25519 = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(sftp(ed25519)).toMatch(/PKCS#8 key of a kind.*ssh-keygen -t ed25519 -N "" -f drop_key/);
  });

  it("puts a key pasted on one line back on its lines", () => {
    const flat = (key: string) => key.trim().replace(/\n/g, " ");
    expect(keyOf(flat(openssh.private))).toBe(openssh.private.trim() + "\n");
    const pem = rsa.export({ type: "pkcs1", format: "pem" }).toString();
    expect(keyOf(flat(pem))).toBe(pem);
    expect(
      sftp("-----BEGIN OPENSSH PRIVATE KEY----- made up -----END OPENSSH PRIVATE KEY-----")
    ).toMatch(/arrived on one line/);
  });

  it("keeps a long run of spaces between the markers fast", () => {
    const started = performance.now();
    const spaced = `-----BEGIN OPENSSH PRIVATE KEY-----${" ".repeat(8_000)}x${" ".repeat(8_000)}-----END OPENSSH PRIVATE KEY-----`;
    expect(sftp(spaced)).toMatch(/arrived on one line/);
    expect(sftp(`-----BEGIN OPENSSH PRIVATE KEY-----${" ".repeat(16_000)}`)).toMatch(
      /not a key drops can use/
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses an EC key whose private value is out of range, without throwing", () => {
    const pem = (label: string, der: Buffer) =>
      `-----BEGIN ${label}-----\n${der
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n")}\n-----END ${label}-----\n`;
    const sec1 = ec.export({ type: "sec1", format: "der" });
    const pkcs8 = ec.export({ type: "pkcs8", format: "der" });
    const scalar = sec1.subarray(7, 39);
    for (const fill of [0x00, 0xff]) {
      const badSec1 = Buffer.from(sec1);
      badSec1.fill(fill, 7, 39);
      expect(() => sftp(pem("EC PRIVATE KEY", badSec1))).not.toThrow();
      expect(sftp(pem("EC PRIVATE KEY", badSec1))).toMatch(/not a key drops can use/);
      const badPkcs8 = Buffer.from(pkcs8);
      const at = badPkcs8.indexOf(scalar);
      expect(at).toBeGreaterThan(0);
      badPkcs8.fill(fill, at, at + 32);
      expect(typeof sftp(pem("PRIVATE KEY", badPkcs8))).toBe("string");
    }
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
