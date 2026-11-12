"use client";

import { useEffect, useRef, useState } from "react";
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** A panel that overflows with nothing focusable inside: the keyboard could not reach it. */
function needsStop(panel: HTMLElement): boolean {
  return panel.scrollHeight > panel.clientHeight && !panel.querySelector(FOCUSABLE);
}

/**
 * No tabindex, as before Base UI (which would make every panel a Tab stop):
 * Tab goes from the bar into the panel's content. A `scroller` panel (one
 * that scrolls its own content) is a Tab stop while it overflows with
 * nothing focusable inside, so the keyboard can reach and scroll it in every
 * browser, as Chrome does for such scrollers itself; a click inside it never
 * focuses it.
 */
function TabsPanel({
  scroller = false,
  ref,
  onPointerDown,
  ...props
}: TabsPrimitive.Panel.Props & { scroller?: boolean }) {
  const own = useRef<HTMLDivElement | null>(null);
  const [stop, setStop] = useState(false);
  useEffect(() => {
    const panel = own.current;
    if (!scroller || !panel) return;
    const check = () => setStop(needsStop(panel));
    check();
    const resize = new ResizeObserver(check);
    resize.observe(panel);
    const content = new MutationObserver(check);
    content.observe(panel, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return () => {
      resize.disconnect();
      content.disconnect();
    };
  }, [scroller]);
  return (
    <TabsPrimitive.Panel
      {...props}
      ref={(node: HTMLDivElement | null) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      tabIndex={stop ? 0 : undefined}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        // Not focusable for the press, so a click reads or selects without focusing it.
        const panel = event.currentTarget;
        // Someone who tabbed in keeps the focus they have.
        if (!stop || document.activeElement === panel) return;
        panel.removeAttribute("tabindex");
        const restore = () => {
          if (needsStop(panel)) panel.setAttribute("tabindex", "0");
        };
        window.addEventListener("pointerup", restore, { once: true });
        window.addEventListener("pointercancel", restore, { once: true });
      }}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanel };
