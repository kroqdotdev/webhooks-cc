import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { FileDropConfig } from "@/lib/drops/config";
import { openDropTarget } from "@/lib/drops/target";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createDestination, pinDropHostKey, trustDropHostKey } from "@/lib/supabase/destinations";
import { PATCH } from "@/app/api/endpoints/[slug]/destinations/[id]/route";

/**
 * File drops against servers that misbehave (local fake servers, so these
 * need FORWARDING_ALLOW_PRIVATE_TARGETS as in development): one that floods
 * without a line break, one that never answers, and pinning a host key only
 * while the drop still goes to that server.
 */

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const servers: net.Server[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const server of servers) server.close();
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function fakeServer(onConnection: (socket: net.Socket) => void): Promise<number> {
  const server = net.createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

const ftp = (port: number): FileDropConfig => ({
  protocol: "ftp",
  host: "127.0.0.1",
  port,
  username: "acme",
  folder: "",
  hostKey: null,
  tlsFingerprint: null,
  endpoint: null,
  region: null,
  bucket: null,
  accessKeyId: null,
  file: "csv",
  rows: "email",
  columns: [],
  prefix: "",
  batch: false,
});

describe("file drops to servers that misbehave", () => {
  it("end a connection that floods without a line break", async () => {
    const port = await fakeServer((socket) => {
      socket.on("error", () => undefined);
      socket.write("220-".padEnd(100_000, "x"));
    });
    const started = Date.now();
    await expect(openDropTarget(ftp(port), { password: "x" })).rejects.toMatchObject({
      message: "The FTP server sent more than a reply.",
      retry: false,
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("end a drop whose server never answers when its deadline runs out", async () => {
    const port = await fakeServer((socket) => socket.on("error", () => undefined));
    const started = Date.now();
    await expect(openDropTarget(ftp(port), { password: "x" }, 1500)).rejects.toMatchObject({
      message: "The drop took too long.",
      retry: true,
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("pin a host key only while the drop still goes to that server", async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `test-drop-pin-${Date.now()}@webhooks-test.local`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    await admin.from("users").update({ plan: "business" }).eq("id", data.user!.id);
    const endpoint = await createEndpointForUser({ userId: data.user!.id, name: "pin" });
    const destination = await createDestination(endpoint.id, {
      url: "sftp://files.acme.example",
      format: "file_drop",
      email: true,
      http: false,
      config: {
        protocol: "sftp",
        host: "files.acme.example",
        port: 22,
        username: "acme",
        folder: "",
        file: "json",
        rows: "email",
        columns: [],
        prefix: "",
        batch: false,
        hostKey: null,
      },
      dropSecret: { password: "x" },
    });
    const key = async () =>
      (
        (
          await admin
            .from("endpoint_destinations")
            .select("config")
            .eq("id", destination.id)
            .single()
        ).data?.config as { hostKey?: string | null }
      ).hostKey ?? null;
    const first = "SHA256:" + "A".repeat(43);
    const second = "SHA256:" + "B".repeat(43);

    // The connection went to a server the drop no longer names: nothing pinned.
    await pinDropHostKey(
      destination.id,
      { host: "evil.example", port: 22, username: "acme" },
      first
    );
    expect(await key()).toBeNull();
    await pinDropHostKey(
      destination.id,
      { host: "files.acme.example", port: 22, username: "acme" },
      first
    );
    expect(await key()).toBe(first);
    // Pinned once; another key never replaces it this way.
    expect(
      await pinDropHostKey(
        destination.id,
        { host: "files.acme.example", port: 22, username: "acme" },
        second
      )
    ).toBe(false);
    expect(await key()).toBe(first);
    // A first connection that saw the pinned key may write; one that saw another may not.
    const target = { host: "files.acme.example", port: 22, username: "acme" };
    expect(await trustDropHostKey(destination.id, target, first)).toBe(true);
    expect(await trustDropHostKey(destination.id, target, second)).toBe(false);
    expect(
      await trustDropHostKey(destination.id, { ...target, host: "other.acme.example" }, first)
    ).toBe(false);
  });

  it("keep a pinned host key unless a change names one, and ask for the secret to change a pin", async () => {
    const email = `test-drop-patch-${Date.now()}@webhooks-test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    await admin.from("users").update({ plan: "business" }).eq("id", data.user!.id);
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({
      email,
      password: "TestPassword123!",
    });
    if (signInError) throw signInError;
    const endpoint = await createEndpointForUser({ userId: data.user!.id, name: "patch" });
    const pinned = "SHA256:" + "C".repeat(43);
    const config = {
      protocol: "sftp",
      host: "files.acme.example",
      port: 22,
      username: "acme",
      folder: "",
      file: "json",
      rows: "email",
      columns: [],
      prefix: "",
      batch: false,
    };
    const destination = await createDestination(endpoint.id, {
      url: "sftp://files.acme.example",
      format: "file_drop",
      email: true,
      http: false,
      config: { ...config, hostKey: pinned },
      dropSecret: { password: "x" },
    });
    const patch = (body: unknown) =>
      PATCH(
        new Request(
          `http://localhost/api/endpoints/${endpoint.slug}/destinations/${destination.id}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${session.session!.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }
        ),
        { params: Promise.resolve({ slug: endpoint.slug, id: destination.id }) }
      );
    const stored = async () =>
      (await admin.from("endpoint_destinations").select("config").eq("id", destination.id).single())
        .data?.config as { hostKey: string | null; prefix: string };

    // A change that leaves the key out keeps it, and needs no secret.
    expect((await patch({ config: { ...config, prefix: "orders-" } })).status).toBe(200);
    expect(await stored()).toMatchObject({ hostKey: pinned, prefix: "orders-" });
    // Forgetting the key, or trusting another one, needs the secret again.
    expect((await patch({ config: { ...config, hostKey: null } })).status).toBe(400);
    expect(
      (await patch({ config: { ...config, hostKey: "SHA256:" + "D".repeat(43) } })).status
    ).toBe(400);
    expect((await stored()).hostKey).toBe(pinned);
    expect(
      (await patch({ config: { ...config, hostKey: null }, dropSecret: { password: "y" } })).status
    ).toBe(200);
    expect((await stored()).hostKey).toBeNull();
  });

  it("ask for the secret when the bucket changes, keep a key sent with a new host, and check the columns when the kinds change", async () => {
    const email = `test-drop-recheck-${Date.now()}@webhooks-test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (error) throw error;
    userIds.push(data.user!.id);
    await admin.from("users").update({ plan: "business" }).eq("id", data.user!.id);
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({
      email,
      password: "TestPassword123!",
    });
    if (signInError) throw signInError;
    const endpoint = await createEndpointForUser({ userId: data.user!.id, name: "recheck" });
    const patch = (id: string, body: unknown) =>
      PATCH(
        new Request(`http://localhost/api/endpoints/${endpoint.slug}/destinations/${id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${session.session!.access_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ slug: endpoint.slug, id }) }
      );
    const stored = async (id: string) =>
      (await admin.from("endpoint_destinations").select("config").eq("id", id).single()).data
        ?.config as Record<string, unknown>;

    const s3 = {
      protocol: "s3",
      endpoint: "https://storage.acme.example",
      region: "eu-central-1",
      bucket: "acme-orders",
      accessKeyId: "AKIAEXAMPLE",
      folder: "",
      file: "json",
      rows: "email",
      columns: [],
      prefix: "",
      batch: false,
    };
    const bucket = await createDestination(endpoint.id, {
      url: "s3://acme-orders",
      format: "file_drop",
      email: true,
      http: false,
      config: s3,
      dropSecret: { secretAccessKey: "x" },
    });
    expect((await patch(bucket.id, { config: { ...s3, bucket: "elsewhere" } })).status).toBe(400);
    expect((await stored(bucket.id)).bucket).toBe("acme-orders");
    expect(
      (
        await patch(bucket.id, {
          config: { ...s3, bucket: "elsewhere" },
          dropSecret: { secretAccessKey: "y" },
        })
      ).status
    ).toBe(200);
    expect((await stored(bucket.id)).bucket).toBe("elsewhere");

    const sftp = {
      protocol: "sftp",
      host: "files.acme.example",
      port: 22,
      username: "acme",
      folder: "",
      file: "csv",
      rows: "email",
      columns: [{ header: "Subject", value: "{{ subject }}" }],
      prefix: "",
      batch: false,
    };
    const drop = await createDestination(endpoint.id, {
      url: "sftp://files.acme.example",
      format: "file_drop",
      email: true,
      http: false,
      config: { ...sftp, hostKey: "SHA256:" + "E".repeat(43) },
      dropSecret: { password: "x" },
    });
    const next = "SHA256:" + "F".repeat(43);
    expect(
      (
        await patch(drop.id, {
          config: { ...sftp, host: "files2.acme.example", hostKey: next },
          dropSecret: { password: "y" },
        })
      ).status
    ).toBe(200);
    expect(await stored(drop.id)).toMatchObject({ host: "files2.acme.example", hostKey: next });
    // Without a key named, a new host starts with none.
    expect(
      (
        await patch(drop.id, {
          config: { ...sftp, host: "files3.acme.example" },
          dropSecret: { password: "z" },
        })
      ).status
    ).toBe(200);
    expect((await stored(drop.id)).hostKey).toBeNull();
    // A subject column needs emails: HTTP requests alone have none.
    const kinds = await patch(drop.id, { email: false, http: true });
    expect(kinds.status).toBe(400);
    expect(((await kinds.json()) as { error: string }).error).toMatch(/subject/);
  });
});
