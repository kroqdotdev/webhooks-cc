import * as React from "react";
import { joinClasses, renderAs } from "./render-as";

type CodeBoxProps = React.ComponentPropsWithRef<"div"> & {
  /** Draws the block as this element instead of a div, usually `<pre />`. */
  render?: React.ReactElement<{ className?: string }>;
};

/** A block of code or output on the muted surface (the `ui-code` rule in globals.css). */
function CodeBox({ render, className, ...props }: CodeBoxProps) {
  return renderAs("div", render, { ...props, className: joinClasses("ui-code", className) });
}

/** A short piece of code inside running text. */
function InlineCode({ className, ...props }: React.ComponentPropsWithRef<"code">) {
  return (
    <code
      className={joinClasses("text-sm bg-muted px-1.5 py-0.5 rounded-sm", className)}
      {...props}
    />
  );
}

export { CodeBox, InlineCode };
