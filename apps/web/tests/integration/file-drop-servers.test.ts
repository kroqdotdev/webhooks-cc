import { readFileSync } from "node:fs";
import net from "node:net";
import { AwsClient } from "aws4fetch";
import { Client } from "ssh2";
import { beforeAll, describe, expect, it } from "vitest";
import type { FileDropConfig } from "@/lib/drops/config";
import { openDropTarget, testDropTarget } from "@/lib/drops/target";

/**
 * File drops against real servers of each kind: SFTP (atmoz/sftp), FTP
 * (delfer/alpine-ftp-server) and the dev S3 (OBJECT_STORAGE_*). Start them
 * with the commands in docs/mailhooks; the suite is skipped when they are
 * not running. Local addresses pass because FORWARDING_ALLOW_PRIVATE_TARGETS
 * is set in development.
 *
 *   docker run -d --name whdev-sftp -p 127.0.0.1:2222:22 \
 *     -v ./no-penalties.sh:/etc/sftp.d/no-penalties.sh:ro atmoz/sftp:alpine "acme:$PW:1001::upload"
 *
 * no-penalties.sh appends "PerSourcePenalties no" to /etc/ssh/sshd_config:
 * these tests log in with wrong passwords on purpose, and OpenSSH 9.8 and
 * later would then refuse every connection from the test host for a while.
 *   docker run -d --name whdev-ftp -p 127.0.0.1:2121:21 -p 127.0.0.1:21000-21010:21000-21010 \
 *     -e USERS="acme|$PW|/home/acme|1001" -e ADDRESS=127.0.0.1 -e MIN_PORT=21000 -e MAX_PORT=21010 \
 *     delfer/alpine-ftp-server
 */

const PASSWORD =
  process.env.DROP_TEST_PASSWORD ??
  (() => {
    try {
      return readFileSync("/tmp/whdev/drops/test-password", "utf8").trim();
    } catch {
      return "";
    }
  })();

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const base = {
  folder: "",
  hostKey: null,
  tlsFingerprint: null,
  endpoint: null,
  region: null,
  bucket: null,
  accessKeyId: null,
  file: "csv" as const,
  rows: "email" as const,
  columns: [],
  prefix: "",
  batch: false,
};

/** Reads a file back over SFTP, to check what was written. */
function readSftp(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () => {
        client.sftp((error, sftp) => {
          if (error) return reject(error);
          sftp.readFile(path, (readError, data) => {
            client.end();
            if (readError) reject(readError);
            else resolve(data.toString("utf8"));
          });
        });
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: 2222, username: "acme", password: PASSWORD });
  });
}

let servers = { sftp: false, ftp: false, ftps: false, s3: false };

const FTPS_FINGERPRINT = (() => {
  try {
    return readFileSync("/tmp/whdev/drops/tls/fingerprint.txt", "utf8").trim();
  } catch {
    return "";
  }
})();

beforeAll(async () => {
  servers = {
    sftp: PASSWORD !== "" && (await reachable(2222)),
    ftp: PASSWORD !== "" && (await reachable(2121)),
    ftps: PASSWORD !== "" && FTPS_FINGERPRINT !== "" && (await reachable(2990)),
    s3: !!process.env.OBJECT_STORAGE_ENDPOINT && !!process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  };
});

describe("file drops to real servers", () => {
  it("write to SFTP, pin the host key, and refuse another key", async (context) => {
    if (!servers.sftp) context.skip();
    const config: FileDropConfig = {
      ...base,
      protocol: "sftp",
      host: "127.0.0.1",
      port: 2222,
      username: "acme",
      folder: "upload",
    };
    const tested = await testDropTarget(config, { password: PASSWORD });
    expect(tested.hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const target = await openDropTarget(
      { ...config, hostKey: tested.hostKey },
      { password: PASSWORD }
    );
    await target.put("orders.csv", Buffer.from("a,b\r\n1,2\r\n"), "text/csv");
    // Written again (a retry): replaced, not refused.
    await target.put("orders.csv", Buffer.from("a,b\r\n3,4\r\n"), "text/csv");
    await target.close();
    expect(await readSftp("upload/orders.csv")).toBe("a,b\r\n3,4\r\n");

    await expect(
      openDropTarget(
        { ...config, hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        { password: PASSWORD }
      )
    ).rejects.toMatchObject({ retry: false, message: expect.stringContaining("host key changed") });
    await expect(openDropTarget(config, { password: "wrong" })).rejects.toMatchObject({
      retry: false,
      message: "The login was refused.",
    });
    await expect(
      openDropTarget({ ...config, folder: "missing" }, { password: PASSWORD })
    ).rejects.toMatchObject({ retry: false });
  });

  it("write to FTP through a passive data connection, renaming into place", async (context) => {
    if (!servers.ftp) context.skip();
    const config: FileDropConfig = {
      ...base,
      protocol: "ftp",
      host: "127.0.0.1",
      port: 2121,
      username: "acme",
    };
    await testDropTarget(config, { password: PASSWORD });
    const target = await openDropTarget(config, { password: PASSWORD });
    await target.put("batch.xml", Buffer.from("<rows/>\n"), "application/xml");
    await target.put("batch.xml", Buffer.from("<rows></rows>\n"), "application/xml");
    await target.close();
    await expect(openDropTarget(config, { password: "wrong" })).rejects.toMatchObject({
      retry: false,
    });
  });

  it("write to FTPS, accepting a self-signed certificate only by its fingerprint", async (context) => {
    if (!servers.ftps) context.skip();
    const config: FileDropConfig = {
      ...base,
      protocol: "ftps",
      host: "127.0.0.1",
      port: 2990,
      username: "acme",
    };
    // Not trusted, and no fingerprint on the drop.
    await expect(openDropTarget(config, { password: PASSWORD })).rejects.toMatchObject({
      retry: false,
      message: expect.stringContaining("not trusted"),
    });
    await expect(
      openDropTarget({ ...config, tlsFingerprint: "00".repeat(32) }, { password: PASSWORD })
    ).rejects.toMatchObject({ message: expect.stringContaining("does not match") });

    const pinned = { ...config, tlsFingerprint: FTPS_FINGERPRINT };
    await testDropTarget(pinned, { password: PASSWORD });
    const target = await openDropTarget(pinned, { password: PASSWORD });
    await target.put("secure.csv", Buffer.from("a\r\n1\r\n"), "text/csv");
    await target.close();
  });

  it("write to S3-compatible storage with a signed PUT", async (context) => {
    if (!servers.s3) context.skip();
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT!;
    const bucket = "webhooks-dev-drops";
    const aws = new AwsClient({
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      service: "s3",
    });
    await aws.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
    const config: FileDropConfig = {
      ...base,
      protocol: "s3",
      host: null,
      port: null,
      username: null,
      endpoint,
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      bucket,
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
      folder: "in/orders",
    };
    const secret = { secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY! };
    await testDropTarget(config, secret);
    const target = await openDropTarget(config, secret);
    await target.put("20261029-a b.json", Buffer.from('{"ok":true}\n'), "application/json");
    const back = await aws.fetch(`${endpoint}/${bucket}/in/orders/20261029-a%20b.json`);
    expect(await back.text()).toBe('{"ok":true}\n');

    await expect(
      openDropTarget(config, { secretAccessKey: "wrong" }).then((t) =>
        t.put("x.json", Buffer.from("{}"), "application/json")
      )
    ).rejects.toMatchObject({ message: "The secret key does not match the access key." });
  });
});
