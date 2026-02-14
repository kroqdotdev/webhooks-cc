"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu, X } from "lucide-react";

interface NavItem {
  title: string;
  href: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Getting Started",
    items: [
      { title: "Quick Start", href: "/docs" },
      { title: "Installation", href: "/installation" },
    ],
  },
  {
    title: "Dashboard",
    items: [
      { title: "Endpoints", href: "/docs/endpoints" },
      { title: "Requests", href: "/docs/requests" },
      { title: "Mock Responses", href: "/docs/mock-responses" },
    ],
  },
  {
    title: "CLI",
    items: [
      { title: "Overview", href: "/docs/cli" },
      { title: "Commands", href: "/docs/cli/commands" },
      { title: "Tunneling", href: "/docs/cli/tunnel" },
    ],
  },
  {
    title: "SDK",
    items: [
      { title: "Overview", href: "/docs/sdk" },
      { title: "API Reference", href: "/docs/sdk/api" },
      { title: "Testing", href: "/docs/sdk/testing" },
    ],
  },
  {
    title: "MCP",
    items: [{ title: "MCP Server", href: "/docs/mcp" }],
  },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="space-y-6">
      {NAV_SECTIONS.map((section) => (
        <div key={section.title}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 px-3">
            {section.title}
          </h3>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "block px-3 py-1.5 text-sm font-medium border-l-4 transition-colors",
                      isActive
                        ? "bg-foreground text-background border-l-primary font-bold"
                        : "border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
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

  return (
    <>
      {/* Mobile toggle - below navbar (h-16 + top-4 + gap) */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="md:hidden fixed top-28 left-4 z-40 p-2 border-2 border-foreground bg-background shadow-neo-sm cursor-pointer"
        aria-label="Toggle docs navigation"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay - starts below navbar to keep navbar clickable */}
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
          "md:hidden fixed top-24 left-4 bottom-4 z-[35] w-64 border-2 border-foreground bg-background shadow-neo overflow-y-auto py-6 transition-transform",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} />
      </aside>

      {/* Desktop floating sidebar */}
      <aside className="hidden md:block w-64 shrink-0 sticky top-24 self-start max-h-[calc(100vh-7rem)] border-2 border-foreground bg-background shadow-neo overflow-y-auto py-6">
        <SidebarContent />
      </aside>
    </>
  );
}
