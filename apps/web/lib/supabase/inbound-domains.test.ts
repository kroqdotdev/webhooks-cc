import { describe, expect, it, vi } from "vitest";

const dnsMock = vi.hoisted(() => ({ txt: vi.fn(), mx: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers() {}
    resolveTxt(name: string) {
      return dnsMock.txt(name);
    }
    resolveMx(domain: string) {
      return dnsMock.mx(domain);
    }
  },
}));

const { systemResolver } = await import("./inbound-domains");

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("the system resolver", () => {
  it("answers no records for a name that does not exist or has none", async () => {
    for (const code of ["ENOTFOUND", "ENODATA", "NXDOMAIN"]) {
      dnsMock.txt.mockRejectedValueOnce(failure(code));
      await expect(systemResolver.txt("_mailhooks.acme.example")).resolves.toEqual([]);
    }
  });

  it("fails a lookup the resolver could not answer, so it never counts as a missing record", async () => {
    dnsMock.txt.mockRejectedValueOnce(failure("ESERVFAIL"));
    await expect(systemResolver.txt("_mailhooks.acme.example")).rejects.toMatchObject({
      code: "ESERVFAIL",
    });
    dnsMock.mx.mockRejectedValueOnce(failure("ESERVFAIL"));
    await expect(systemResolver.mx("acme.example")).rejects.toMatchObject({
      code: "ESERVFAIL",
    });
  });
});
