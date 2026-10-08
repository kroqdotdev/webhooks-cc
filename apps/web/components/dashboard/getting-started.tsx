"use client";

import { useState, useEffect } from "react";
import { Terminal, Code, Bot, Send } from "lucide-react";

const STORAGE_KEY = "getting_started_dismissed";
const VISITED_KEY = "getting_started_visited";

function safeSetStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (incognito/disabled) — checklist still works in-memory
  }
}

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

/** The setup checklist behind the endpoint bar's Setup menu. */
export function useGettingStarted(hasReceivedWebhook: boolean) {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash
  const [visited, setVisited] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "true") return;
      setDismissed(false);
      const v = localStorage.getItem(VISITED_KEY);
      if (v) setVisited(new Set(JSON.parse(v) as string[]));
    } catch {
      // localStorage unavailable (incognito/disabled): stay dismissed
    }
  }, []);

  const isDone = (id: string) => (id === "webhook" && hasReceivedWebhook) || visited.has(id);
  const progress = ITEMS.filter((item) => isDone(item.id)).length;
  const total = ITEMS.length;

  const dismiss = () => {
    setDismissed(true);
    safeSetStorage(STORAGE_KEY, "true");
  };
  const markVisited = (id: string) => {
    setVisited((prev) => {
      const next = new Set(prev).add(id);
      safeSetStorage(VISITED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  return {
    items: ITEMS,
    isDone,
    progress,
    total,
    open: !dismissed && progress < total,
    dismiss,
    markVisited,
  };
}
