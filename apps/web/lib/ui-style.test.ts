import { describe, expect, it } from "vitest";
import {
  appearanceBootstrapScript,
  UI_STYLE_ASSIGNED_STORAGE_KEY,
  UI_STYLE_SOURCE_STORAGE_KEY,
  UI_STYLE_STORAGE_KEY,
} from "./ui-style";

/** Runs the inline bootstrap script against a fake browser. */
function run(options: {
  split: number;
  storage?: Record<string, string>;
  cookie?: string;
  random?: number;
  prefersDark?: boolean;
  blockStorage?: boolean;
}) {
  const store = new Map(Object.entries(options.storage ?? {}));
  const localStorage = {
    getItem: (key: string) => {
      if (options.blockStorage) throw new Error("storage blocked");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void store.set(key, value),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const document = {
    documentElement: { dataset, classList: { add: (c: string) => void classes.add(c) } },
    cookie: options.cookie ?? "",
  };
  const window = { matchMedia: () => ({ matches: options.prefersDark ?? false }) };
  const math = { ...Math, random: () => options.random ?? 0.5 };

  const script = appearanceBootstrapScript(options.split);
  new Function("document", "localStorage", "window", "Math", script)(
    document,
    localStorage,
    window,
    math
  );

  return { style: dataset.style, classes, stored: Object.fromEntries(store) };
}

describe("appearanceBootstrapScript", () => {
  it("applies dark mode from the stored theme before paint", () => {
    expect(run({ split: 0, storage: { theme: "dark" } }).classes.has("dark")).toBe(true);
    expect(run({ split: 0, prefersDark: true }).classes.has("dark")).toBe(true);
    expect(
      run({ split: 0, storage: { theme: "light" }, prefersDark: true }).classes.has("dark")
    ).toBe(false);
  });

  it("still honors the system theme when storage is blocked", () => {
    const result = run({ split: 100, blockStorage: true, prefersDark: true, random: 0 });
    expect(result.classes.has("dark")).toBe(true);
    expect(result.style).toBe("classic");
  });

  it("keeps a style the visitor already has", () => {
    const result = run({ split: 100, storage: { [UI_STYLE_STORAGE_KEY]: "classic" } });
    expect(result.style).toBe("classic");
    expect(result.stored[UI_STYLE_ASSIGNED_STORAGE_KEY]).toBeUndefined();
  });

  it("leaves visitors who have been here before out of the split", () => {
    const seenBefore: Record<string, string>[] = [{ theme: "dark" }, { ph_phc_test_posthog: "{}" }];
    for (const storage of seenBefore) {
      const result = run({ split: 100, storage, random: 0 });
      expect(result.style).toBe("classic");
      expect(result.stored[UI_STYLE_STORAGE_KEY]).toBeUndefined();
    }
    const withSession = run({ split: 100, cookie: "sb-abc-auth-token=x", random: 0 });
    expect(withSession.style).toBe("classic");
    expect(withSession.stored[UI_STYLE_STORAGE_KEY]).toBeUndefined();
  });

  it("assigns a brand-new browser and records the variant", () => {
    const clean = run({ split: 50, random: 0.2 });
    expect(clean.style).toBe("clean");
    expect(clean.stored).toMatchObject({
      [UI_STYLE_STORAGE_KEY]: "clean",
      [UI_STYLE_SOURCE_STORAGE_KEY]: "assigned",
      [UI_STYLE_ASSIGNED_STORAGE_KEY]: "clean",
    });

    const classic = run({ split: 50, random: 0.9 });
    expect(classic.style).toBe("classic");
    expect(classic.stored[UI_STYLE_ASSIGNED_STORAGE_KEY]).toBe("classic");
  });

  it("stops assigning when the split is zero", () => {
    const result = run({ split: 0, random: 0 });
    expect(result.style).toBe("classic");
    expect(result.stored[UI_STYLE_STORAGE_KEY]).toBeUndefined();
  });

  it("clamps the split percentage", () => {
    expect(appearanceBootstrapScript(140)).toContain("100 > 0");
    expect(appearanceBootstrapScript(-5)).toContain("0 > 0");
  });
});
