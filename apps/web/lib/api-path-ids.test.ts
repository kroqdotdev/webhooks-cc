import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_ID_ROUTES,
  OTHER_SEGMENTS,
  STATIC_SIBLINGS,
  UUID_SEGMENTS,
  malformedApiId,
} from "./api-path-ids";

const API_DIR = join(__dirname, "..", "app", "api");
const UUID = "0b9f6a52-3f43-4c47-9a83-2f7d8a1c5e10";

/** Every directory under app/api that holds a route.ts, as /api/... paths. */
function routeDirs(dir = API_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    try {
      if (statSync(join(full, "route.ts")).isFile()) {
        out.push(`/api/${relative(API_DIR, full).split(sep).join("/")}`);
      }
    } catch {
      // no route here
    }
    out.push(...routeDirs(full));
  }
  return out;
}

function dynamicSegments(route: string): string[] {
  return [...route.matchAll(/\[(?:\.\.\.)?(\w+)\]/g)].map((m) => m[1]);
}

const ROUTES = routeDirs();

describe("API path ids", () => {
  it("classifies every dynamic segment under app/api", () => {
    for (const route of ROUTES) {
      if (route.startsWith("/api/ops/") || route.includes("[...")) continue;
      for (const name of dynamicSegments(route)) {
        expect(
          UUID_SEGMENTS.has(name) || OTHER_SEGMENTS.has(name),
          `${route}: add [${name}] to UUID_SEGMENTS or OTHER_SEGMENTS`
        ).toBe(true);
      }
    }
  });

  it("lists exactly the routes that take a UUID in their path", () => {
    const expected = ROUTES.filter(
      (route) =>
        !route.startsWith("/api/ops/") &&
        dynamicSegments(route).some((name) => UUID_SEGMENTS.has(name))
    ).sort();
    expect([...API_ID_ROUTES].sort()).toEqual(expected);
  });

  it("lists exactly the static directories beside a UUID segment", () => {
    const expected = new Set<string>();
    for (const route of ROUTES) {
      if (route.startsWith("/api/ops/")) continue;
      const parts = route.split("/");
      parts.forEach((part, i) => {
        const match = /^\[(\w+)\]$/.exec(part);
        if (!match || !UUID_SEGMENTS.has(match[1])) return;
        const parent = parts.slice(0, i).join("/");
        for (const other of ROUTES) {
          const otherParts = other.split("/");
          if (otherParts.length <= i || otherParts.slice(0, i).join("/") !== parent) continue;
          if (!otherParts[i].startsWith("[")) expected.add(otherParts.slice(0, i + 1).join("/"));
        }
      });
    }
    expect([...STATIC_SIBLINGS].sort()).toEqual([...expected].sort());
  });

  it("sweeps every UUID route: a malformed id is caught, a UUID passes", () => {
    for (const route of API_ID_ROUTES) {
      const fill = (bad: string) =>
        route.replace(/\[(\w+)\]/g, (_, name: string) =>
          UUID_SEGMENTS.has(name) ? bad : name === "index" ? "0" : "acme-slug"
        );
      expect(malformedApiId(fill(UUID)), route).toBe(false);
      for (const bad of ["nope", "123", `${UUID}x`, "%E0%A4%A", "%20"]) {
        expect(malformedApiId(fill(bad)), `${route} with ${bad}`).toBe(true);
      }
    }
  });

  it("leaves static siblings, other paths and staff routes alone", () => {
    expect(malformedApiId("/api/approvals/decide")).toBe(false);
    expect(malformedApiId("/api/approvals/review")).toBe(false);
    expect(malformedApiId("/api/endpoints/acme/destinations/order")).toBe(false);
    expect(malformedApiId("/api/endpoints/acme/destinations/preview")).toBe(false);
    expect(malformedApiId("/api/endpoints/acme")).toBe(false);
    expect(malformedApiId("/api/requests")).toBe(false);
    expect(malformedApiId("/api/ops/accounts/nope")).toBe(false);
    expect(malformedApiId("/dashboard/requests/nope")).toBe(false);
    // A path no route has is the catch-all's 404, not this one.
    expect(malformedApiId("/api/requests/nope/unknown")).toBe(false);
  });
});
