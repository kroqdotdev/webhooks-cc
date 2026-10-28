import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appearanceBootstrapScript,
  readUiStyle,
  storeChosenUiStyle,
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

/** A localStorage stand-in for the client helpers, which read the real global. */
function stubStorage(initial: Record<string, string> = {}, blocked = false) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (blocked) throw new Error("storage blocked");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error("storage blocked");
      store.set(key, value);
    },
  });
  return store;
}

describe("readUiStyle", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The Appearance page's radio must show what the inline script applied, so
  // the two read the same storage the same way.
  it("agrees with the bootstrap script for every stored state", () => {
    const cases: Record<string, string>[] = [
      {},
      { [UI_STYLE_STORAGE_KEY]: "classic" },
      { [UI_STYLE_STORAGE_KEY]: "classic", [UI_STYLE_SOURCE_STORAGE_KEY]: "assigned" },
      { [UI_STYLE_STORAGE_KEY]: "classic", [UI_STYLE_SOURCE_STORAGE_KEY]: "chosen" },
      { [UI_STYLE_STORAGE_KEY]: "clean", [UI_STYLE_SOURCE_STORAGE_KEY]: "chosen" },
      { [UI_STYLE_STORAGE_KEY]: "neon", [UI_STYLE_SOURCE_STORAGE_KEY]: "chosen" },
    ];
    for (const storage of cases) {
      stubStorage(storage);
      expect(readUiStyle(), JSON.stringify(storage)).toBe(run({ storage }).style);
    }
  });

  it("falls back to clean when storage is blocked", () => {
    stubStorage({}, true);
    expect(readUiStyle()).toBe("clean");
  });
});

describe("storeChosenUiStyle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records a pick the script will keep", () => {
    const store = stubStorage();
    storeChosenUiStyle("classic");
    expect(store.get(UI_STYLE_SOURCE_STORAGE_KEY)).toBe("chosen");
    expect(run({ storage: Object.fromEntries(store) }).style).toBe("classic");
    expect(readUiStyle()).toBe("classic");
  });

  it("does not throw when storage is blocked", () => {
    stubStorage({}, true);
    expect(() => storeChosenUiStyle("classic")).not.toThrow();
  });
});
