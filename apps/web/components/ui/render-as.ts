import * as React from "react";

/** Class names joined in order, without merging: a call site's classes sit beside the look's. */
export function joinClasses(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * The element a look is drawn on: `tag` by default, or the `render` element
 * with the look's props added (its own props, children and ref kept, the
 * class names joined). The same shape as Base UI's `render` prop, with no
 * hooks, so server components can use it.
 */
export function renderAs(
  tag: string,
  render: React.ReactElement<{ className?: string }> | undefined,
  props: { className?: string } & Record<string, unknown>
): React.ReactElement {
  if (!render) return React.createElement(tag, props);
  const own = render.props;
  return React.cloneElement(render, {
    ...props,
    ...own,
    className: joinClasses(props.className, own.className),
  });
}
