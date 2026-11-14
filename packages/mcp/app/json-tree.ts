import { el, type Child } from "./dom";

/**
 * A JSON value as a tree of <details> elements: objects and arrays fold,
 * the first levels start open. Keys and values are text nodes. Past
 * MAX_NODES the caller shows the raw body instead.
 */

const MAX_NODES = 4_000;
const OPEN_DEPTH = 3;

class TooLarge extends Error {}

export function jsonTree(value: unknown): HTMLElement | null {
  let nodes = 0;
  const count = () => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new TooLarge();
  };

  const scalar = (input: unknown): HTMLElement => {
    count();
    if (typeof input === "string") return el("span", { class: "j-str" }, JSON.stringify(input));
    if (typeof input === "number") return el("span", { class: "j-num" }, String(input));
    if (typeof input === "boolean") return el("span", { class: "j-bool" }, String(input));
    return el("span", { class: "j-null" }, "null");
  };

  const node = (input: unknown, key: Child, depth: number, last: boolean): HTMLElement => {
    const comma = last ? null : el("span", { class: "j-punct" }, ",");
    const label =
      key === null
        ? null
        : el("span", { class: "j-key" }, key, el("span", { class: "j-punct" }, ": "));
    if (input === null || typeof input !== "object") {
      return el("div", { class: "j-row" }, label, scalar(input), comma);
    }
    count();
    const array = Array.isArray(input);
    const entries: [Child, unknown][] = array
      ? (input as unknown[]).map((item) => [null, item] as [Child, unknown])
      : Object.entries(input as Record<string, unknown>).map(
          ([name, item]) => [JSON.stringify(name), item] as [Child, unknown]
        );
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    if (entries.length === 0) {
      return el(
        "div",
        { class: "j-row" },
        label,
        el("span", { class: "j-punct" }, open + close),
        comma
      );
    }
    const summary = el(
      "summary",
      { class: "j-row" },
      label,
      el("span", { class: "j-punct" }, open),
      el(
        "span",
        { class: "j-count" },
        array
          ? `${entries.length} ${entries.length === 1 ? "item" : "items"}`
          : `${entries.length} ${entries.length === 1 ? "key" : "keys"}`
      ),
      // Shown while folded, so a folded node still reads as closed.
      el(
        "span",
        { class: "j-tail" },
        el("span", { class: "j-punct" }, close),
        comma ? comma.cloneNode(true) : null
      )
    );
    const children = el("div", { class: "j-children" });
    entries.forEach(([name, item], index) => {
      children.appendChild(node(item, name, depth + 1, index === entries.length - 1));
    });
    const details = el(
      "details",
      { class: "j-node" },
      summary,
      children,
      el("div", { class: "j-row j-close" }, el("span", { class: "j-punct" }, close), comma)
    );
    details.open = depth < OPEN_DEPTH;
    return details;
  };

  try {
    return el("div", { class: "j-tree" }, node(value, null, 0, true));
  } catch (error) {
    if (error instanceof TooLarge) return null;
    throw error;
  }
}
