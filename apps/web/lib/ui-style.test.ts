import { describe, expect, it } from "vitest";
import {
  appearanceBootstrapScript,
  UI_STYLE_SOURCE_STORAGE_KEY,
  UI_STYLE_STORAGE_KEY,
} from "./ui-style";

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
  const dataset: Record<string, string> = {};
  const document = {
    documentElement: { dataset, classList: { add: (c: string) => void classes.add(c) } },
  };
  const window = { matchMedia: () => ({ matches: options.prefersDark ?? false }) };

  new Function("document", "localStorage", "window", appearanceBootstrapScript())(
    document,
    localStorage,
    window
  );

  return { style: dataset.style, classes };
}

describe("appearanceBootstrapScript", () => {
  it("applies dark mode from the stored theme before paint", () => {
    expect(run({ storage: { theme: "dark" } }).classes.has("dark")).toBe(true);
    expect(run({ prefersDark: true }).classes.has("dark")).toBe(true);
    expect(run({ storage: { theme: "light" }, prefersDark: true }).classes.has("dark")).toBe(false);
  });

  it("gives everyone the clean style by default", () => {
    expect(run({}).style).toBe("clean");
  });

  it("keeps a style the visitor picked", () => {
    const picked = {
      [UI_STYLE_STORAGE_KEY]: "classic",
      [UI_STYLE_SOURCE_STORAGE_KEY]: "chosen",
    };
    expect(run({ storage: picked }).style).toBe("classic");
  });

  it("ignores a style the retired split assigned", () => {
    const assigned = {
      [UI_STYLE_STORAGE_KEY]: "classic",
      [UI_STYLE_SOURCE_STORAGE_KEY]: "assigned",
      "ui-style-assigned": "classic",
    };
    expect(run({ storage: assigned }).style).toBe("clean");
    expect(run({ storage: { [UI_STYLE_STORAGE_KEY]: "classic" } }).style).toBe("clean");
  });

  it("still honors the system theme when storage is blocked", () => {
    const result = run({ blockStorage: true, prefersDark: true });
    expect(result.classes.has("dark")).toBe(true);
    expect(result.style).toBe("clean");
  });
});
