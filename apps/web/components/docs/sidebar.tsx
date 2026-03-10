"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu, X, ChevronDown, Search } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/docs-nav";

const STORAGE_KEY = "docs-sidebar-sections";

function getInitialState(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function SidebarContent({
  onNavigate,
  onSearchClick,
}: {
  onNavigate?: () => void;
  onSearchClick?: () => void;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsed(getInitialState());
  }, []);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }, []);

  return (
    <nav className="space-y-1">
      {/* Search trigger */}
      <button
        onClick={onSearchClick}
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 mb-4 text-sm text-muted-foreground border-2 border-foreground/30 hover:border-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <Search className="h-4 w-4" />
        <span>Search</span>
        <kbd className="ml-auto text-xs border border-foreground/30 px-1.5 py-0.5 font-mono hidden sm:inline">
          ⌘K
        </kbd>
      </button>

      {NAV_SECTIONS.map((section) => {
        const isCollapsed = collapsed[section.id] ?? false;
        const hasActive = section.items.some(
          (item) =>
            pathname === item.href ||
            (!item.depth && item.href !== "/docs" && pathname.startsWith(`${item.href}/`))
        );
        const showItems = hasActive || !isCollapsed;

        return (
          <div key={section.id} className="mb-2">
            <button
              onClick={() => toggle(section.id)}
              type="button"
              className="flex w-full items-center justify-between px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {section.title}
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", !showItems && "-rotate-90")}
              />
            </button>
            {showItems && (
              <ul className="space-y-0.5 mt-0.5">
                {section.items.map((item) => {
                  const isActive =
                    pathname === item.href ||
                    (!item.depth && item.href !== "/docs" && pathname.startsWith(`${item.href}/`));

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 py-1.5 text-sm font-medium border-l-4 transition-colors",
                          item.depth ? "pl-6 pr-3" : "px-3",
                          isActive
                            ? "bg-foreground text-background border-l-primary font-bold"
                            : "border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        {item.title}
                        {item.isNew && (
                          <span className="text-[10px] font-bold uppercase bg-primary text-primary-foreground px-1.5 py-0.5 border border-foreground">
                            New
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function DocsSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen]);

  const handleSearchClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-docs-search"));
    setMobileOpen(false);
  }, []);

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="md:hidden fixed top-28 left-4 z-40 p-2 border-2 border-foreground bg-background shadow-neo-sm cursor-pointer"
        aria-label="Toggle docs navigation"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed top-24 left-0 right-0 bottom-0 z-30 bg-background/80"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? "true" : undefined}
        aria-label="Documentation navigation"
        aria-hidden={!mobileOpen}
        className={cn(
          "md:hidden fixed top-24 left-4 bottom-4 z-[35] w-64 border-2 border-foreground bg-background shadow-neo overflow-y-auto py-6 px-2 transition-transform",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} onSearchClick={handleSearchClick} />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:block w-64 shrink-0 sticky top-24 self-start max-h-[calc(100vh-7rem)] border-2 border-foreground bg-background shadow-neo overflow-y-auto py-6 px-2">
        <SidebarContent onSearchClick={handleSearchClick} />
      </aside>
    </>
  );
}
