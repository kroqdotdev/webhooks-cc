import { describe, expect, it } from "vitest";
import { networkNotice } from "./device-login-notice";

describe("networkNotice", () => {
  it("says nothing for a login from the browser's own network", () => {
    expect(networkNotice("same", false)).toBeNull();
    expect(networkNotice("same", true)).toBeNull();
  });

  it("warns about a different network, whatever the terminal claims", () => {
    expect(networkNotice("different", false)?.level).toBe("warning");
    const remote = networkNotice("different", true);
    expect(remote?.level).toBe("warning");
    expect(remote?.text).toContain("which any terminal can say");
  });

  it("cautions when the networks could not be compared", () => {
    // The requester picks its IP version, so this must not be silent.
    expect(networkNotice("unknown", false)?.level).toBe("caution");
    expect(networkNotice("unknown", true)?.level).toBe("caution");
  });

  it("names a request when it is not a login", () => {
    expect(networkNotice("different", false, "request")?.text).toMatch(/^This request came/);
    expect(networkNotice("unknown", false, "request")?.text).toContain("this request came");
  });
});
