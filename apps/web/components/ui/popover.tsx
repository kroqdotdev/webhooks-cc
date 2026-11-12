"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

/**
 * A panel a button opens beside something on the page; it closes on Escape,
 * on a press outside it and when focus leaves it, and hands focus back to its
 * button. Unstyled parts: Root, Trigger, Portal (its `container` keeps the
 * panel in another element's stacking context), Backdrop, Positioner
 * (`anchor` places it against an element other than the trigger) and Popup.
 */
const Popover = PopoverPrimitive;

export { Popover };
