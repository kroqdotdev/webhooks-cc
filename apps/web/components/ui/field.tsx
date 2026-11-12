import * as React from "react";
import { joinClasses, renderAs } from "./render-as";

type FieldControlProps = React.ComponentPropsWithRef<"input"> & {
  /** Draws the look on this control instead of an input: `render={<select />}`, `<textarea />`. */
  render?: React.ReactElement<{ className?: string }>;
};

/**
 * A form control in the field look: the `ui-input` rule in globals.css, a
 * card-white box with the 3:1 control edge and a soft ring on focus. An input
 * by default.
 */
function FieldControl({ render, className, ...props }: FieldControlProps) {
  return renderAs("input", render, { ...props, className: joinClasses("ui-input", className) });
}

export { FieldControl };
