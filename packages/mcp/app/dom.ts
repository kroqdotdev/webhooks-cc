/**
 * Building the page from text only: every value goes in as a text node or
 * an attribute, never as markup, because the values are captured data.
 */

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  title?: string;
  /** Plain attributes (aria-*, type, role-free ones); values are set as text. */
  attrs?: Record<string, string>;
  onClick?: (event: MouseEvent) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.class) node.className = props.class;
  if (props?.title) node.title = props.title;
  if (props?.attrs) {
    for (const [name, value] of Object.entries(props.attrs)) node.setAttribute(name, value);
  }
  const onClick = props?.onClick;
  if (onClick) node.addEventListener("click", (event) => onClick(event as MouseEvent));
  append(node, children);
  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/** A button: type button, so nothing ever submits. */
export function button(
  label: Child,
  onClick: (event: MouseEvent) => void,
  cls = "btn"
): HTMLButtonElement {
  return el("button", { class: cls, attrs: { type: "button" }, onClick }, label);
}

/** Bytes as people read them. */
export function bytes(count: number | null): string | null {
  if (count === null) return null;
  if (count < 1024) return `${count} B`;
  const units = ["KB", "MB", "GB"];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
