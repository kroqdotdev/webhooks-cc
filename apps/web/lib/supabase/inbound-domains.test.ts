import { describe, expect, it, vi } from "vitest";

const dnsMock = vi.hoisted(() => ({ txt: vi.fn(), mx: vi.fn(), servers: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers(servers: string[]) {
      dnsMock.servers(servers);
    }
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

  it("uses the public resolvers when DOMAIN_DNS_SERVERS names none", async () => {
    // Blank passes the startup check (it means unset), so it must not leave
    // the resolver with no servers, which would fail every check.
    vi.stubEnv("DOMAIN_DNS_SERVERS", "   ");
    vi.resetModules();
    try {
      const fresh = await import("./inbound-domains");
      dnsMock.txt.mockResolvedValueOnce([]);
      await fresh.systemResolver.txt("_mailhooks.acme.example");
      expect(dnsMock.servers).toHaveBeenLastCalledWith(["1.1.1.1", "1.0.0.1"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
