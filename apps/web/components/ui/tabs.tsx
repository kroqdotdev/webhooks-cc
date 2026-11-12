"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

/**
 * Unstyled: each tab bar draws its own look with `data-active:` classes. A
 * controlled `value` must change in the same render as `onValueChange`: a tab
 * told late is chosen again by the click that follows its focus.
 */
const Tabs = TabsPrimitive.Root;

/** The arrow keys move to a tab and show it, as they always have here. */
function TabsList(props: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List activateOnFocus {...props} />;
}

const TabsTab = TabsPrimitive.Tab;

/**
 * Not a stop of its own when tabbing: Tab goes from the bar into the panel's
 * content, as it did before Base UI.
 */
function TabsPanel(props: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel tabIndex={-1} {...props} />;
}

export { Tabs, TabsList, TabsTab, TabsPanel };
