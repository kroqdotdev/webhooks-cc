import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEBHOOKS_TOP_LEVEL, existsOnWebhooks } from "./site";

const root = join(__dirname, "..");

/** The first path segments app/ serves: route folders, with route groups opened up. */
function appSegments(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, "app"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("(")) {
      for (const inner of readdirSync(join(root, "app", entry.name), { withFileTypes: true })) {
        if (inner.isDirectory()) out.push(inner.name);
      }
    } else if (!entry.name.startsWith("_") && !entry.name.startsWith("[")) {
      out.push(entry.name);
    }
  }
  return out;
}

describe("WEBHOOKS_TOP_LEVEL", () => {
  it("lists every top-level route of webhooks.cc", () => {
    const listed = new Set<string>(WEBHOOKS_TOP_LEVEL);
    const missing = appSegments().filter((name) => name !== "mailhooks" && !listed.has(name));
    expect(missing).toEqual([]);
  });

  it("covers every file and folder in public/", () => {
    const missing = readdirSync(join(root, "public")).filter(
      (name) => !existsOnWebhooks(`/${name}`)
    );
    expect(missing).toEqual([]);
  });

  it("does not claim a mistyped path", () => {
    expect(existsOnWebhooks("/pricng")).toBe(false);
    expect(existsOnWebhooks("/docs/email-capture")).toBe(true);
  });
});
