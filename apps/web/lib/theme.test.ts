import { describe, expect, it } from "vitest";
import { themeBootstrapScript } from "./theme";

/** Runs the inline bootstrap script against a fake browser. */
function run(options: {
  storage?: Record<string, string>;
  prefersDark?: boolean;
  blockStorage?: boolean;
}) {
  const store = new Map(Object.entries(options.storage ?? {}));
  const localStorage = {
    getItem: (key: string) => {
      if (options.blockStorage) throw new Error("storage blocked");
      return store.get(key) ?? null;
    },
  };
  const classes = new Set<string>();
  const document = { documentElement: { classList: { add: (c: string) => void classes.add(c) } } };
  const window = { matchMedia: () => ({ matches: options.prefersDark ?? false }) };

  new Function("document", "localStorage", "window", themeBootstrapScript())(
    document,
    localStorage,
    window
  );

  return { dark: classes.has("dark") };
}

describe("themeBootstrapScript", () => {
  it("applies dark mode from the stored theme before paint", () => {
    expect(run({ storage: { theme: "dark" } }).dark).toBe(true);
    expect(run({ prefersDark: true }).dark).toBe(true);
    expect(run({ storage: { theme: "light" }, prefersDark: true }).dark).toBe(false);
    expect(run({ storage: { theme: "system" }, prefersDark: false }).dark).toBe(false);
  });

  it("still honors the system theme when storage is blocked", () => {
    expect(run({ blockStorage: true, prefersDark: true }).dark).toBe(true);
  });
});
