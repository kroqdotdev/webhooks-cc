"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

/**
 * A button that shows and hides a panel. Unstyled: a trigger turns its chevron
 * with `group-data-panel-open:rotate-180`, and the panel is unmounted while
 * closed unless it is given `keepMounted`.
 */
const Collapsible = CollapsiblePrimitive.Root;
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
const CollapsiblePanel = CollapsiblePrimitive.Panel;

export { Collapsible, CollapsibleTrigger, CollapsiblePanel };
