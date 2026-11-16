import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ allowed: true }));

vi.mock("@/lib/drops/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/drops/connect")>()),
  dropsOffered: () => true,
}));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  allowPrivateTargets: () => false,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: rpc.allowed, error: null }),
  }),
}));

import { fileDropProblem } from "./destination-input";

function dropChanges() {
  return {
    format: "file_drop" as const,
    config: {
      protocol: "sftp",
      host: "drops.acme.example",
      port: 22,
      username: "acme",
      folder: "upload",
      file: "csv",
      rows: "email",
      columns: [{ header: "Subject", value: "{{ subject }}" }],
      prefix: "orders-",
    },
    secret: { password: "x" },
  };
}

describe("fileDropProblem", () => {
  beforeEach(() => {
    rpc.allowed = true;
  });

  it("answers a plan without file drops the way every plan gate does", async () => {
    rpc.allowed = false;
    expect(await fileDropProblem("endpoint-1", dropChanges())).toEqual({
      error: "File drops are part of Business.",
      code: "plan_required",
      status: 403,
    });
  });

  it("keeps the request's own problems at 400 without a code", async () => {
    expect(await fileDropProblem("endpoint-1", { ...dropChanges(), secret: null })).toEqual({
      error: "Enter the password or a private key for the SFTP server.",
      status: 400,
    });
    expect(await fileDropProblem("endpoint-1", dropChanges())).toBeNull();
  });
});
