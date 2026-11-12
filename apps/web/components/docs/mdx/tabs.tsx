"use client";

import { useState, Children, isValidElement, type ReactElement } from "react";
import { Tabs as TabsRoot, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";

export function Tabs({ items, children }: { items?: string[]; children: React.ReactNode }) {
  const [active, setActive] = useState(0);
  const tabs = Children.toArray(children).filter(isValidElement) as ReactElement<{
    label?: string;
  }>[];

  // Derive labels from items prop, or from Tab label props, or fallback to "Tab N"
  const labels = items ?? tabs.map((tab, i) => tab.props.label ?? `Tab ${i + 1}`);

  return (
    <TabsRoot
      value={active}
      onValueChange={(next) => setActive(next as number)}
      className="my-6 rounded-lg border border-border shadow-surface overflow-hidden"
    >
      <TabsList className="flex border-b border-border overflow-x-auto">
        {labels.map((label, i) => (
          <TabsTab
            key={label}
            value={i}
            className="px-4 py-2 text-sm font-bold transition-colors cursor-pointer data-active:bg-selected data-active:text-selected-foreground not-data-active:bg-background not-data-active:text-muted-foreground not-data-active:hover:text-foreground not-data-active:hover:bg-muted"
          >
            {label}
          </TabsTab>
        ))}
      </TabsList>
      <TabsPanel
        value={active}
        className="[&>div>pre]:my-0 [&>div>pre]:rounded-none [&>div>pre]:border-0 [&>div>pre]:shadow-none [&>div>div]:my-0 [&>div>div]:rounded-none [&>div>div]:border-0 [&>div>div]:shadow-none"
      >
        {tabs[active]}
      </TabsPanel>
    </TabsRoot>
  );
}

export function Tab({ children }: { label?: string; children: React.ReactNode }) {
  return <div>{children}</div>;
}
