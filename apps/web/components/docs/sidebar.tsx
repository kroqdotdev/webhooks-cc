"use client";

import { useState } from "react";
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
    title: "Integrations",
    items: [
      { title: "Stripe", href: "/docs/webhooks/stripe" },
      { title: "GitHub", href: "/docs/webhooks/github" },
      { title: "Shopify", href: "/docs/webhooks/shopify" },
    ],
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

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="md:hidden fixed top-[72px] left-4 z-40 p-2 border-2 border-foreground bg-background shadow-neo-sm cursor-pointer"
        aria-label="Toggle docs navigation"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-background/80"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={cn(
          "md:hidden fixed top-[56px] left-0 bottom-0 z-30 w-64 border-r-2 border-foreground bg-background overflow-y-auto py-6 transition-transform",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent onNavigate={() => setMobileOpen(false)} />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:block w-64 shrink-0 border-r-2 border-foreground overflow-y-auto py-6">
        <SidebarContent />
      </aside>
    </>
  );
}
