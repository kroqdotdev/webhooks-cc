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
 * No tabindex, as before Base UI (which would make every panel a Tab stop):
 * Tab goes from the bar into the panel's content, and a panel that scrolls
 * with nothing focusable inside stays reachable, as the browser makes such
 * a scroller focusable itself. A negative tabindex would turn that off.
 */
function TabsPanel(props: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel tabIndex={undefined} {...props} />;
}

export { Tabs, TabsList, TabsTab, TabsPanel };
