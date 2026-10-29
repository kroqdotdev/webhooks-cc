import { readFileSync } from "node:fs";
import net from "node:net";
import { AwsClient } from "aws4fetch";
import { Client } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createDestination } from "@/lib/supabase/destinations";
import { runForwardingBatch } from "@/lib/forwarding/worker";
import { fileDropProblem, parseDestinationInput } from "@/lib/forwarding/destination-input";
import { dropFileName } from "@/lib/drops/files";

/**
 * File drop destinations (migration 00074) end to end: captures queue
 * deliveries, the forwarding worker writes the files to the SFTP test server
 * and the dev S3 (see file-drop-servers.test.ts for starting them), one per
 * email or one per batch, pins the SFTP host key, and pauses on a plan
 * without file drops. Skipped when the test servers are not running.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PASSWORD = (() => {
  try {
    return readFileSync("/tmp/whdev/drops/test-password", "utf8").trim();
  } catch {
    return process.env.DROP_TEST_PASSWORD ?? "";
  }
})();
const ts = Date.now();
const userIds: string[] = [];
const endpointIds: string[] = [];
let sftpUp = false;
let s3Up = false;

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

beforeAll(async () => {
  sftpUp = PASSWORD !== "" && (await reachable(2222));
  s3Up = !!process.env.OBJECT_STORAGE_ENDPOINT && !!process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
});

afterAll(async () => {
  for (const id of endpointIds) {
    await admin.from("endpoint_destinations").update({ enabled: false }).eq("endpoint_id", id);
    await admin.from("endpoints").delete().eq("id", id);
  }
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function createUser(plan: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-drops-${userIds.length}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  userIds.push(id);
  await admin.from("users").update({ plan, subscription_status: "active" }).eq("id", id);
  return id;
}

async function capture(slug: string, subject: string) {
  const { error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: `${slug}@mailhooks.cc`,
    p_headers: { subject },
    p_body: "raw",
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_kind: "email",
    p_email: { subject, text: "body", from: [{ name: null, address: "orders@acme.example" }] },
  });
  if (error) throw error;
}

async function drain(endpointId: string) {
  for (let i = 0; i < 10; i++) {
    await runForwardingBatch(16);
    const { data } = await admin
      .from("email_deliveries")
      .select("id")
      .eq("endpoint_id", endpointId)
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString());
    if (!data || data.length === 0) return;
  }
}

async function deliveries(endpointId: string) {
  const { data } = await admin
    .from("email_deliveries")
    .select("status, format, last_error")
    .eq("endpoint_id", endpointId);
  return data ?? [];
}

function sftp<T>(work: (sftp: import("ssh2").SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on("ready", () =>
        client.sftp((error, wrapper) => {
          if (error) return reject(error);
          work(wrapper)
            .then(resolve, reject)
            .finally(() => client.end());
        })
      )
      .on("error", reject)
      .connect({ host: "127.0.0.1", port: 2222, username: "acme", password: PASSWORD });
  });
}

const sftpConfig = (folder: string) => ({
  protocol: "sftp",
  host: "127.0.0.1",
  port: 2222,
  username: "acme",
  folder,
  file: "csv",
  rows: "email",
  columns: [
    { header: "Subject", value: "{{ subject }}" },
    { header: "From", value: "{{ from.address }}" },
  ],
  prefix: "orders-",
});

describe("file drop destinations", () => {
  it("write a CSV file per email to SFTP and pin the host key", async (context) => {
    if (!sftpUp) context.skip();
    const userId = await createUser("business");
    const endpoint = await createEndpointForUser({ userId, name: "drops" });
    endpointIds.push(endpoint.id);
    // Each run writes to its own folder (created here, as the customer would).
    const folder = `upload/run-${ts}`;
    await sftp(
      (s) =>
        new Promise<void>((resolve, reject) => s.mkdir(folder, (e) => (e ? reject(e) : resolve())))
    );
    const destination = await createDestination(endpoint.id, {
      url: "sftp://127.0.0.1:2222",
      format: "file_drop",
      email: true,
      http: false,
      config: sftpConfig(folder),
      dropSecret: { password: PASSWORD },
    });
    await capture(endpoint.slug, "Order #1");
    await capture(endpoint.slug, "Order, #2");
    await drain(endpoint.id);

    const rows = await deliveries(endpoint.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "succeeded" && row.format === "file_drop")).toBe(
      true
    );
    const names = await sftp(
      (s) =>
        new Promise<string[]>((resolve, reject) =>
          s.readdir(folder, (e, list) =>
            e ? reject(e) : resolve(list.map((f) => f.filename).sort())
          )
        )
    );
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^orders-\d{8}-\d{6}-[0-9a-f]{8}\.csv$/.test(name))).toBe(true);
    const contents = await sftp((s) =>
      Promise.all(
        names.map(
          (name) =>
            new Promise<string>((resolve, reject) =>
              s.readFile(`${folder}/${name}`, (e, data) =>
                e ? reject(e) : resolve(data.toString())
              )
            )
        )
      )
    );
    expect(contents.sort()).toEqual([
      'Subject,From\r\n"Order, #2",orders@acme.example\r\n',
      "Subject,From\r\nOrder #1,orders@acme.example\r\n",
    ]);

    const { data: stored } = await admin
      .from("endpoint_destinations")
      .select("config")
      .eq("id", destination.id)
      .single();
    expect((stored?.config as { hostKey?: string }).hostKey).toMatch(/^SHA256:/);
  });

  it("write one JSON file for a batch to S3", async (context) => {
    if (!s3Up) context.skip();
    const userId = await createUser("business");
    const endpoint = await createEndpointForUser({ userId, name: "batch" });
    endpointIds.push(endpoint.id);
    const endpointUrl = process.env.OBJECT_STORAGE_ENDPOINT!;
    const aws = new AwsClient({
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
      region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      service: "s3",
    });
    await aws.fetch(`${endpointUrl}/webhooks-dev-drops`, { method: "PUT" });
    const prefix = `batches/${ts}`;
    await createDestination(endpoint.id, {
      url: "s3://webhooks-dev-drops",
      format: "file_drop",
      email: true,
      http: false,
      // The batch collects for the destination's delay.
      delaySeconds: 600,
      config: {
        protocol: "s3",
        endpoint: endpointUrl,
        region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
        bucket: "webhooks-dev-drops",
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID!,
        folder: prefix,
        file: "json",
        rows: "email",
        columns: [],
        prefix: "",
        batch: true,
      },
      dropSecret: { secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY! },
    });
    await capture(endpoint.slug, "First");
    await capture(endpoint.slug, "Second");
    await capture(endpoint.slug, "Third");
    await drain(endpoint.id);
    // Nothing is due yet: the batch is still collecting.
    expect((await deliveries(endpoint.id)).every((row) => row.status === "pending")).toBe(true);

    // The oldest comes due: it takes the others with it.
    const { data: oldest } = await admin
      .from("email_deliveries")
      .select("id")
      .eq("endpoint_id", endpoint.id)
      .order("created_at")
      .limit(1)
      .single();
    await admin
      .from("email_deliveries")
      .update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", oldest!.id);
    await drain(endpoint.id);
    const rows = await deliveries(endpoint.id);
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
    // Named after the batch's first request.
    const { data: first } = await admin
      .from("requests")
      .select("id, received_at")
      .eq("endpoint_id", endpoint.id)
      .order("received_at")
      .limit(1)
      .single();
    const file = dropFileName(
      "",
      { id: first!.id, receivedAt: new Date(first!.received_at).toISOString() },
      "json",
      true
    );
    const listed = await aws.fetch(`${endpointUrl}/webhooks-dev-drops/${prefix}/${file}`);
    const documents = (await listed.json()) as { subject?: string; email?: { subject?: string } }[];
    expect(documents).toHaveLength(3);
  });

  it("pause on a plan without file drops, and fail without retrying on a refused login", async (context) => {
    if (!sftpUp) context.skip();
    const free = await createUser("free");
    const endpoint = await createEndpointForUser({ userId: free, name: "free" });
    endpointIds.push(endpoint.id);
    // Saved through the API, a drop on Free is refused...
    const parsed = parseDestinationInput(
      { format: "file_drop", config: sftpConfig("upload"), dropSecret: { password: "x" } },
      { creating: true }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      await fileDropProblem(endpoint.id, {
        format: "file_drop",
        config: parsed.changes.config!,
        secret: parsed.changes.dropSecret!,
      })
    ).toBe("File drops are part of Business.");
    // ... and one kept from Business pauses.
    await createDestination(endpoint.id, {
      url: "sftp://127.0.0.1:2222",
      format: "file_drop",
      email: true,
      http: false,
      config: sftpConfig("upload"),
      dropSecret: { password: PASSWORD },
    });
    await capture(endpoint.slug, "Paused");
    await drain(endpoint.id);
    expect(await deliveries(endpoint.id)).toMatchObject([
      { status: "skipped", last_error: expect.stringContaining("part of Business") },
    ]);

    const business = await createUser("business");
    const other = await createEndpointForUser({ userId: business, name: "refused" });
    endpointIds.push(other.id);
    await createDestination(other.id, {
      url: "sftp://127.0.0.1:2222",
      format: "file_drop",
      email: true,
      http: false,
      config: sftpConfig("upload"),
      dropSecret: { password: "wrong-password" },
    });
    await capture(other.slug, "Refused");
    await drain(other.id);
    expect(await deliveries(other.id)).toMatchObject([
      { status: "failed", last_error: "The login was refused." },
    ]);
  });
});
