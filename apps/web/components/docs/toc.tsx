"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export function TableOfContents({ headings }: { headings: TocItem[] }) {
  const [activeId, setActiveId] = useState<string>("");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter(Boolean) as HTMLElement[];

    if (elements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((e) => e.isIntersecting);
        if (visible) {
          setActiveId(visible.target.id);
        }
      },
      { rootMargin: "-96px 0px -70% 0px" }
    );

    elements.forEach((el) => observerRef.current?.observe(el));

    return () => observerRef.current?.disconnect();
  }, [headings]);

  if (headings.length < 3) return null;

  return (
    <>
      {/* Desktop: sticky sidebar */}
      <aside className="hidden xl:block w-48 shrink-0 sticky top-24 self-start max-h-[calc(100vh-7rem)] overflow-y-auto">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
          On this page
        </p>
        <nav aria-label="Table of contents">
          <ul className="space-y-1.5 text-sm">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  className={cn(
                    "block py-0.5 transition-colors",
                    h.level === 3 ? "pl-3" : "pl-0",
                    activeId === h.id
                      ? "text-foreground font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Mobile: collapsible dropdown above content */}
      <MobileToc headings={headings} activeId={activeId} />
    </>
  );
}

function MobileToc({ headings, activeId }: { headings: TocItem[]; activeId: string }) {
  const [open, setOpen] = useState(false);

  if (headings.length < 3) return null;

  return (
    <div className="xl:hidden mb-6 border-2 border-foreground bg-card">
      <button
        onClick={() => setOpen(!open)}
        type="button"
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-bold cursor-pointer"
      >
        On this page
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <nav className="px-4 pb-3 border-t-2 border-foreground" aria-label="Table of contents">
          <ul className="space-y-1.5 text-sm pt-2">
            {headings.map((h) => (
              <li key={h.id}>
                <a
                  href={`#${h.id}`}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "block py-0.5 transition-colors",
                    h.level === 3 ? "pl-3" : "pl-0",
                    activeId === h.id
                      ? "text-foreground font-bold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
