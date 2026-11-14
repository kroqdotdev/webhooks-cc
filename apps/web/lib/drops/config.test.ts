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
  const key = (body: string) => ({ privateKey: body });

  it("takes a whole key", () => {
    const whole =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up\n-----END OPENSSH PRIVATE KEY-----\n";
    expect(parseDropSecret(key(whole), "sftp")).toEqual({ privateKey: whole });
  });

  it("refuses a key cut off after its BEGIN line", () => {
    expect(parseDropSecret(key("-----BEGIN OPENSSH PRIVATE KEY-----"), "sftp")).toMatch(
      /whole private key/
    );
    expect(parseDropSecret(key("-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up\n"), "sftp")).toMatch(
      /whole private key/
    );
  });

  it("refuses an empty body or END lines of another kind", () => {
    expect(
      parseDropSecret(key("-----BEGIN RSA PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----"), "sftp")
    ).toMatch(/whole private key/);
    expect(
      parseDropSecret(
        key("-----BEGIN RSA PRIVATE KEY-----\nmade-up\n-----END OPENSSH PRIVATE KEY-----"),
        "sftp"
      )
    ).toMatch(/whole private key/);
  });

  it("still takes a password", () => {
    expect(parseDropSecret({ password: "hunter2" }, "sftp")).toEqual({
      password: "hunter2",
      privateKey: undefined,
    });
  });
});
