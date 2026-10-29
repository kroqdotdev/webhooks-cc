import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Just enough of a DOM node: the real methods throw where the browser's do. */
class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];

  constructor(readonly name: string) {}

  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new DOMException("not a child of this node", "NotFoundError");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(node: FakeNode, child: FakeNode | null): FakeNode {
    const index = child ? this.childNodes.indexOf(child) : this.childNodes.length;
    if (index === -1) throw new DOMException("not a child of this node", "NotFoundError");
    node.parentNode?.removeChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  /** What Chrome's translator does to a text node: a <font> takes its place, the text is detached. */
  translate(child: FakeNode): FakeNode {
    const font = new FakeNode(`font(${child.name})`);
    this.insertBefore(font, child);
    this.removeChild(child);
    return font;
  }
}

function names(node: FakeNode): string[] {
  return node.childNodes.map((child) => child.name);
}

let document: { documentElement: { className: string }; querySelector: () => unknown };

async function load() {
  vi.resetModules();
  const page = await import("./translated-page");
  // A prototype of its own for each test, so earlier tests' guards do not stack up.
  class Guarded extends FakeNode {}
  page.guardDomMutations(Guarded.prototype as unknown as Node);
  return { page, Guarded };
}

beforeEach(() => {
  document = { documentElement: { className: "font-variable" }, querySelector: () => null };
  vi.stubGlobal("document", document);
});
afterEach(() => vi.unstubAllGlobals());

describe("on a page nobody translated", () => {
  it("still throws where the browser would", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const stranger = new Guarded("x");
    expect(() => parent.removeChild(stranger)).toThrow("not a child");
    expect(() => parent.insertBefore(new Guarded("n"), stranger)).toThrow("not a child");
  });

  it("does not report the page as translated", async () => {
    const { page } = await load();
    expect(page.pageWasTranslated()).toBe(false);
  });
});

describe("on a translated page", () => {
  beforeEach(() => {
    document.documentElement.className = "font-variable translated-ltr";
  });

  it("skips removing text the translator already took out", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const text = new Guarded("text");
    parent.insertBefore(text, null);
    parent.translate(text);
    expect(parent.removeChild(text)).toBe(text);
    expect(names(parent)).toEqual(["font(text)"]);
  });

  it("removes a node someone wrapped from its wrapper", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const wrapper = new Guarded("font");
    const child = new Guarded("a");
    parent.insertBefore(wrapper, null);
    wrapper.insertBefore(child, null);
    parent.removeChild(child);
    expect(names(wrapper)).toEqual([]);
    expect(child.parentNode).toBeNull();
  });

  it("inserts last when the reference text is gone", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const text = new Guarded("text");
    parent.insertBefore(text, null);
    parent.insertBefore(new Guarded("b"), null);
    parent.translate(text);
    parent.insertBefore(new Guarded("icon"), text);
    expect(names(parent)).toEqual(["font(text)", "b", "icon"]);
  });

  it("inserts before the wrapper that holds the reference", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const wrapper = new Guarded("font");
    const child = new Guarded("a");
    parent.insertBefore(wrapper, null);
    parent.insertBefore(new Guarded("b"), null);
    wrapper.insertBefore(child, null);
    parent.insertBefore(new Guarded("icon"), child);
    expect(names(parent)).toEqual(["icon", "font", "b"]);
  });

  it("leaves ordinary removals and insertions alone", async () => {
    const { Guarded } = await load();
    const parent = new Guarded("p");
    const a = new Guarded("a");
    parent.insertBefore(a, null);
    parent.insertBefore(new Guarded("b"), a);
    expect(names(parent)).toEqual(["b", "a"]);
    parent.removeChild(a);
    expect(names(parent)).toEqual(["b"]);
  });
});

describe("pageWasTranslated", () => {
  it("recognises the translator's <font> elements without its class", async () => {
    document.querySelector = () => ({});
    const { page } = await load();
    expect(page.pageWasTranslated()).toBe(true);
  });

  it("stays true after the class is gone", async () => {
    document.documentElement.className = "translated-rtl";
    const { page } = await load();
    expect(page.pageWasTranslated()).toBe(true);
    // A client render after a failed hydration resets the attributes of <html>.
    document.documentElement.className = "font-variable";
    expect(page.pageWasTranslated()).toBe(true);
  });
});
