import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointSite } from "@/lib/site";
import { switchNextPath } from "./site-switcher";

describe("switchNextPath", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3210");
    vi.stubEnv("NEXT_PUBLIC_MAILHOOKS_URL", "http://mailhooks.localhost:3210");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const listed = (site: EndpointSite | undefined) => (slug: string) =>
    slug === "acme" ? { site } : null;

  it("keeps an app page and its query, both sites serve those", () => {
    expect(switchNextPath("/dashboard", "?endpoint=acme", "mailhooks")).toBe(
      "/dashboard?endpoint=acme"
    );
    expect(switchNextPath("/account/api-keys", "", "mailhooks")).toBe("/account/api-keys");
    expect(switchNextPath("/teams", "", "webhooks")).toBe("/teams");
  });

  it("goes to the other site's home from any other page", () => {
    expect(switchNextPath("/docs/layouts", "", "mailhooks")).toBe("/");
    expect(switchNextPath("/dashboards-are-not-this", "", "mailhooks")).toBe("/");
  });

  it("goes from one pricing page to the other's", () => {
    expect(switchNextPath("/pricing", "?x=1", "webhooks")).toBe("/pricing");
    expect(switchNextPath("/pricing", "", "mailhooks")).toBe("/pricing");
  });

  it("keeps the open endpoint when the other site lists it", () => {
    expect(switchNextPath("/dashboard", "?endpoint=acme", "webhooks", listed("both"))).toBe(
      "/dashboard?endpoint=acme"
    );
    expect(switchNextPath("/dashboard", "?endpoint=acme", "webhooks", listed("webhooks"))).toBe(
      "/dashboard?endpoint=acme"
    );
    expect(switchNextPath("/dashboard", "?endpoint=acme", "webhooks", listed(undefined))).toBe(
      "/dashboard?endpoint=acme"
    );
  });

  it("drops the open endpoint when the other site does not list it", () => {
    expect(switchNextPath("/dashboard", "?endpoint=acme", "webhooks", listed("mailhooks"))).toBe(
      "/dashboard"
    );
    expect(
      switchNextPath("/dashboard", "?endpoint=acme&tab=settings", "mailhooks", listed("webhooks"))
    ).toBe("/dashboard?tab=settings");
  });

  it("keeps an endpoint the dashboard has not described", () => {
    expect(switchNextPath("/dashboard", "?endpoint=other", "webhooks", listed("mailhooks"))).toBe(
      "/dashboard?endpoint=other"
    );
  });
});
