"use client";

import { useState, useEffect } from "react";
import { Terminal, Send, Mail, LayoutList, Forward, Reply } from "lucide-react";
import type { SettingsSection } from "./settings-primitives";

const STORAGE_KEY = "getting_started_dismissed";
const VISITED_KEY = "getting_started_visited";

function safeSetStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (incognito/disabled); the checklist still works in-memory
  }
}

export interface ChecklistItem {
  id: string;
  label: string;
  /** A page to read; the item is ticked once it was opened. */
  href?: string;
  /** The settings section that does the step; the item is ticked from the endpoint. */
  section?: SettingsSection;
  icon: React.ElementType;
}

/**
 * webhooks.cc's checklist. All but the last are ticked from the endpoint
 * itself, never from a click.
 */
const ITEMS: ChecklistItem[] = [
  { id: "webhook", label: "Receive your first webhook", icon: Send },
  { id: "mock", label: "Set a mock response", section: "responses", icon: Reply },
  {
    id: "destination",
    label: "Forward to a URL or localhost",
    section: "forwarding",
    icon: Forward,
  },
  // Kept as "cli" so a visit recorded before the list changed still counts.
  { id: "cli", label: "Connect a tool", href: "/docs/cli", icon: Terminal },
];

/**
 * mailhooks.cc's checklist: the steps that make mail useful. The first three
 * are ticked from the endpoint itself, never from a click.
 */
const MAIL_ITEMS: ChecklistItem[] = [
  { id: "webhook", label: "Receive your first email", icon: Mail },
  { id: "layout", label: "Add a layout", section: "layouts", icon: LayoutList },
  { id: "destination", label: "Send it somewhere", section: "forwarding", icon: Send },
  { id: "forward", label: "Forward a mailbox here", href: "/docs/email-capture", icon: Forward },
];

/** What the endpoint already has, for ticking the checklist. */
export interface SetupState {
  layout: boolean;
  destination: boolean;
  /** A mock response or response rules. */
  mock: boolean;
}

/** The setup checklist behind the endpoint bar's Setup menu; `mail` picks mailhooks.cc's. */
export function useGettingStarted(
  hasReceivedWebhook: boolean,
  state: SetupState | undefined,
  mail: boolean
) {
  const items = mail ? MAIL_ITEMS : ITEMS;
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

  const isDone = (id: string) =>
    (id === "webhook" && hasReceivedWebhook) ||
    (id === "layout" && !!state?.layout) ||
    (id === "destination" && !!state?.destination) ||
    (id === "mock" && !!state?.mock) ||
    visited.has(id);
  const progress = items.filter((item) => isDone(item.id)).length;
  const total = items.length;

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
    items,
    isDone,
    progress,
    total,
    open: !dismissed && progress < total,
    dismiss,
    markVisited,
  };
}
