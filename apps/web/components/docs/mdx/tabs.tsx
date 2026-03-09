"use client";

import { useState, Children, isValidElement } from "react";
import { cn } from "@/lib/utils";

export function Tabs({
  items,
  children,
}: {
  items: string[];
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(0);
  const tabs = Children.toArray(children).filter(isValidElement);

  return (
    <div className="my-6 border-2 border-foreground shadow-neo-sm">
      <div className="flex border-b-2 border-foreground">
        {items.map((label, i) => (
          <button
            key={label}
            onClick={() => setActive(i)}
            type="button"
            className={cn(
              "px-4 py-2 text-sm font-bold transition-colors cursor-pointer",
              i === active
                ? "bg-foreground text-background"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="[&>div>pre]:my-0 [&>div>pre]:border-0 [&>div>pre]:shadow-none [&>div>div]:my-0 [&>div>div]:border-0 [&>div>div]:shadow-none">
        {tabs[active]}
      </div>
    </div>
  );
}

export function Tab({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
