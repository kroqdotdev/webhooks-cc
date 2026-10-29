import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { FileDropConfig } from "@/lib/drops/config";
import { openDropTarget } from "@/lib/drops/target";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { createDestination, pinDropHostKey } from "@/lib/supabase/destinations";

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
    await pinDropHostKey(
      destination.id,
      { host: "files.acme.example", port: 22, username: "acme" },
      second
    );
    expect(await key()).toBe(first);
  });
});
