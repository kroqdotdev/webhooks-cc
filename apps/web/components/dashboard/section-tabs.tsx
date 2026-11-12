"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Whether a horizontally scrolling element has more content past its right
 * edge: a tab strip fades there only then, at any width.
 */
function useMoreToRight<T extends HTMLElement>() {
  const [more, setMore] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((element: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!element) return;
    const update = () =>
      setMore(element.scrollWidth - element.clientWidth - element.scrollLeft > 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", update, { passive: true });
    update();
    cleanup.current = () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  return [ref, more] as const;
}

export interface SectionTab<T extends string> {
  id: T;
  label: ReactNode;
  /** Shown after the label, and read as ", 3". */
  count?: number;
}

/**
 * The tab bar over a request or an email, inside the Tabs that hold its
 * panel. On a phone the strip scrolls sideways, fades on the right while there
 * is more, and keeps the active tab in view without moving the page itself,
 * which scrollIntoView could do. Arrow keys move between the tabs.
 */
export function SectionTabList<T extends string>({
  label,
  tabs,
  active,
  trailingDivider = false,
  onReselect,
}: {
  label: string;
  tabs: SectionTab<T>[];
  active: T;
  /** A divider after the last tab too. */
  trailingDivider?: boolean;
  /** A click on the tab already shown, which Tabs itself ignores. */
  onReselect?: (id: T) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Whether the tab pressed was already shown: by the click, pressing has shown it.
  const pressedShown = useRef(false);
  const [moreRef, more] = useMoreToRight<HTMLDivElement>();
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      stripRef.current = element;
      moreRef(element);
    },
    [moreRef]
  );
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!strip || !tab) return;
    // Shown from elsewhere (a number key, a parse finishing) while the bar has
    // focus: focus follows, so Shift+Tab back does not land on, and show, the old tab.
    const focused = document.activeElement;
    if (focused !== tab && focused instanceof HTMLElement && strip.contains(focused)) {
      tab.focus({ preventScroll: true });
    }
    if (strip.scrollWidth <= strip.clientWidth) return;
    const stripBox = strip.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    const fade = 32;
    if (box.left < stripBox.left) strip.scrollLeft += box.left - stripBox.left;
    else if (box.right > stripBox.right - fade) {
      strip.scrollLeft += Math.min(box.right - stripBox.right + fade, box.left - stripBox.left);
    }
  }, [active]);

  return (
    <div className="shrink-0 border-b">
      <div
        ref={ref}
        className={cn(
          "flex overflow-x-auto [scrollbar-width:none]",
          more && "[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)]"
        )}
      >
        <TabsList aria-label={label} className="flex shrink-0">
          {tabs.map((tab) => (
            <TabsTab
              key={tab.id}
              value={tab.id}
              data-tab={tab.id}
              onPointerDown={() => {
                pressedShown.current = tab.id === active;
              }}
              onClick={(event) => {
                // Enter or Space (no pointer) clicks the focused tab, which is the one shown.
                const reselected = event.detail === 0 ? tab.id === active : pressedShown.current;
                pressedShown.current = false;
                if (reselected) onReselect?.(tab.id);
              }}
              className={cn(
                "px-4 py-2 text-xs font-bold border-r border-border cursor-pointer transition-colors whitespace-nowrap capitalize",
                "bg-background not-data-active:hover:bg-muted",
                // The tint alone is too faint, so the active tab also gets a primary underline.
                "data-active:bg-selected data-active:text-selected-foreground data-active:shadow-[inset_0_-2px_0_hsl(var(--primary))]",
                !trailingDivider && "last:border-r-0"
              )}
            >
              {tab.label}
              {tab.count !== undefined && (
                <>
                  <span className="sr-only">, </span>
                  <span className="ml-1.5 font-mono opacity-70">{tab.count}</span>
                </>
              )}
            </TabsTab>
          ))}
        </TabsList>
      </div>
    </div>
  );
}
