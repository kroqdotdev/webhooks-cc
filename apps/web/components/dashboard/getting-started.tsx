"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Check, X, Terminal, Code, Bot, Send } from "lucide-react";

const STORAGE_KEY = "getting_started_dismissed";

interface ChecklistItem {
  id: string;
  label: string;
  href?: string;
  icon: React.ElementType;
}

const ITEMS: ChecklistItem[] = [
  { id: "webhook", label: "Receive your first webhook", icon: Send },
  { id: "cli", label: "Install the CLI", href: "/docs/cli", icon: Terminal },
  { id: "sdk", label: "Install the SDK", href: "/docs/sdk", icon: Code },
  { id: "mcp", label: "Set up MCP", href: "/docs/mcp", icon: Bot },
];

export function GettingStarted({ hasReceivedWebhook }: { hasReceivedWebhook: boolean }) {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash
  const [visited, setVisited] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") return;
      setDismissed(false);

      const v = localStorage.getItem("getting_started_visited");
      if (v) setVisited(new Set(JSON.parse(v) as string[]));
    } catch {
      // localStorage unavailable (incognito/disabled) — stay dismissed
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, "true");
  };

  const markVisited = (id: string) => {
    setVisited((prev) => {
      const next = new Set(prev).add(id);
      localStorage.setItem("getting_started_visited", JSON.stringify([...next]));
      return next;
    });
  };

  const progress = ITEMS.filter(
    (item) => (item.id === "webhook" && hasReceivedWebhook) || visited.has(item.id)
  ).length;
  const total = ITEMS.length;

  // Auto-dismiss when all items complete
  useEffect(() => {
    if (!dismissed && progress >= total) {
      setDismissed(true);
      localStorage.setItem(STORAGE_KEY, "true");
    }
  }, [dismissed, progress, total]);

  if (dismissed) return null;

  return (
    <div className="border-b-2 border-foreground bg-card px-4 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Getting started ({progress}/{total})
        </p>
        <button
          onClick={handleDismiss}
          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss getting started"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {ITEMS.map((item) => {
          const done = (item.id === "webhook" && hasReceivedWebhook) || visited.has(item.id);
          const Icon = item.icon;

          if (item.href) {
            return (
              <Link
                key={item.id}
                href={item.href}
                onClick={() => markVisited(item.id)}
                className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 border-2 border-foreground transition-colors cursor-pointer ${
                  done
                    ? "bg-primary/15 text-muted-foreground line-through"
                    : "bg-background hover:bg-muted"
                }`}
              >
                {done ? <Check className="h-3 w-3 text-primary" /> : <Icon className="h-3 w-3" />}
                {item.label}
              </Link>
            );
          }

          return (
            <span
              key={item.id}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 border-2 border-foreground ${
                done ? "bg-primary/15 text-muted-foreground line-through" : "bg-background"
              }`}
            >
              {done ? <Check className="h-3 w-3 text-primary" /> : <Icon className="h-3 w-3" />}
              {item.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
