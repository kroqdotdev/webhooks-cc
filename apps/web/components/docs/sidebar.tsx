"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { SiteLink } from "@/components/nav/site-link";
import { useSitePathname } from "@/lib/site-pathname";
import { cn } from "@/lib/utils";
import { BookOpen, X, ChevronDown, Search } from "lucide-react";
import { NAV_SECTIONS, type NavSection } from "@/lib/docs-nav";
import { SITE_HEADER_HEIGHT, siteHeaderTop } from "@/lib/announcements";

function sectionHasPage(section: NavSection, pathname: string): boolean {
  return section.items.some(
    (item) =>
      pathname === item.href ||
      (!item.depth && item.href !== "/docs" && pathname.startsWith(`${item.href}/`))
  );
}

/**
 * Only the section holding the current page starts open, so the list stays
 * short enough to scan. A section the reader opens or closes by hand keeps
 * that state until they navigate; the next page starts tidy again.
 */
const noSubscribe = () => () => {};
/** Whether the search shortcut is Cmd (Apple devices) or Ctrl; the server renders Cmd. */
function useIsApple(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true
  );
}

function SidebarContent({
  onNavigate,
  onSearchClick,
}: {
  onNavigate?: () => void;
  onSearchClick?: () => void;
}) {
  const pathname = useSitePathname();
  const isApple = useIsApple();
  const [toggled, setToggled] = useState<{ path: string; open: Record<string, boolean> }>({
    path: pathname,
    open: {},
  });
  const open = toggled.path === pathname ? toggled.open : {};

  const isOpen = (section: NavSection) => open[section.id] ?? sectionHasPage(section, pathname);

  const toggle = (section: NavSection) => {
    const next = !isOpen(section);
    setToggled((prev) => ({
      path: pathname,
      open: { ...(prev.path === pathname ? prev.open : {}), [section.id]: next },
    }));
  };

  return (
    <nav className="space-y-1">
      {/* Search trigger */}
      <button
        onClick={onSearchClick}
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 mb-4 text-sm text-muted-foreground rounded-md border border-foreground/30 hover:text-foreground transition-colors cursor-pointer hover:border-foreground/50"
      >
        <Search className="h-4 w-4" />
        <span>Search</span>
        <kbd className="ml-auto text-xs rounded-sm border border-foreground/30 px-1.5 py-0.5 font-mono hidden sm:inline">
          {isApple ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      {NAV_SECTIONS.map((section) => {
        const showItems = isOpen(section);

        return (
          <div key={section.id} className="mb-2">
            <button
              onClick={() => toggle(section)}
              type="button"
              aria-expanded={showItems}
              className="flex w-full items-center justify-between px-3 py-1.5 text-xs font-bold text-muted-foreground hover:text-foreground cursor-pointer"
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
                      <SiteLink
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 py-1.5 text-sm font-medium border-l-4 transition-colors",
                          item.depth ? "pl-6 pr-3" : "px-3",
                          isActive
                            ? "bg-selected text-selected-foreground border-l-primary font-bold"
                            : "border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
                        )}
                      >
                        {item.title}
                        {item.isNew && (
                          <span className="text-[10px] font-bold bg-primary text-primary-foreground px-1.5 py-0.5 rounded-sm border border-border normal-case">
                            New
                          </span>
                        )}
                      </SiteLink>
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

// Everything sticky or fixed here hangs off the header, which itself sits below
// the fixed banners (see siteHeaderTop).
function useSidebarStyles() {
  const headerBottom = `calc(${siteHeaderTop()} + ${SITE_HEADER_HEIGHT})`;
  const toggle = `calc(${headerBottom} + 1rem)`;
  const panel = headerBottom;
  const desktop = headerBottom;
  const maxH = `calc(100vh - ${headerBottom})`;
  return { toggle, panel, desktop, maxH };
}

export function DocsSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const s = useSidebarStyles();

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
        className="md:hidden fixed left-4 z-40 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold rounded-md border border-border bg-background shadow-xs cursor-pointer"
        style={{ top: s.toggle }}
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? "Close docs contents" : "Open docs contents"}
      >
        {/* A word, not a second hamburger under the site menu's. */}
        {mobileOpen ? <X className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
        Contents
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed left-0 right-0 bottom-0 z-30 bg-background/80"
          style={{ top: s.panel }}
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
          "md:hidden fixed left-0 bottom-0 z-[35] w-72 border-r border-border shadow-md overflow-y-auto pt-16 pb-6 px-2 transition-transform bg-card",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ top: s.panel }}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} onSearchClick={handleSearchClick} />
      </aside>

      {/* Desktop sidebar */}
      <aside
        className="hidden md:block w-64 shrink-0 sticky self-start border-r border-border overflow-y-auto py-8 pr-4"
        style={{ top: s.desktop, maxHeight: s.maxH }}
      >
        <SidebarContent onSearchClick={handleSearchClick} />
      </aside>
    </>
  );
}
