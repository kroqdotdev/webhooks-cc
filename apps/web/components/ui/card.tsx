import * as React from "react";
import { joinClasses, renderAs } from "./render-as";

type CardProps = React.ComponentPropsWithRef<"div"> & {
  /** Draws the card as this element instead of a div: `render={<Link href="/" />}`. */
  render?: React.ReactElement<{ className?: string }>;
  /** A card that is itself clickable darkens its hairline under the pointer. */
  interactive?: boolean;
};

/**
 * A white surface edged by a hairline. Its look is the `ui-card` rule in
 * globals.css, in the components layer, so any utility passed in wins.
 */
function Card({ render, interactive = false, className, ...props }: CardProps) {
  return renderAs("div", render, {
    ...props,
    className: joinClasses("ui-card", !interactive && "ui-card-static", className),
  });
}

export { Card };
