"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

/**
 * A set of choices of which one is picked: one tab stop for the group, and
 * the arrow keys move the choice. Unstyled; a change is reported through
 * `onValueChange` only (a radio's `onClick` still runs, but arrow keys never
 * click, and a click on the picked radio reports nothing). Each radio leaves a hidden
 * input beside it, out of the flow, so style the group with `gap-*` rather
 * than `space-*`, `divide-*` or `first:`/`last:`.
 */
const RadioGroup = RadioGroupPrimitive;

/**
 * One choice in a RadioGroup, a native button unless `render` gives another
 * element (pass `nativeButton` too when that element is a button). It carries
 * `data-checked` when picked.
 */
function Radio({ render, nativeButton, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      nativeButton={render ? nativeButton : true}
      render={render ?? <button type="button" />}
      {...props}
    />
  );
}

export { RadioGroup, Radio };
