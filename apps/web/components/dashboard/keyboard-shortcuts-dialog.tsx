"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ShortcutDef {
  key: string;
  label: string;
}

const SHORTCUT_GROUPS: { title: string; shortcuts: ShortcutDef[] }[] = [
  {
    title: "Navigation",
    shortcuts: [
      { key: "j", label: "Next request" },
      { key: "k", label: "Previous request" },
      { key: "/", label: "Focus search" },
      { key: "Esc", label: "Close dialog / blur input" },
    ],
  },
  {
    // The keys the dashboard's handler maps to TABS in request-detail.tsx; change them together.
    title: "Tabs",
    shortcuts: [
      { key: "1", label: "Body tab" },
      { key: "2", label: "Headers tab" },
      { key: "3", label: "Query tab" },
      { key: "4", label: "Raw tab" },
      { key: "5", label: "Signature tab" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { key: "c", label: "Copy cURL command" },
      { key: "r", label: "Open replay dialog" },
      { key: "n", label: "New endpoint" },
      { key: "l", label: "Toggle live / paused" },
      { key: "[", label: "Toggle sidebar" },
      { key: "?", label: "Show keyboard shortcuts" },
    ],
  },
];

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="tracking-normal">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-bold text-muted-foreground mb-2 tracking-normal">
                {group.title}
              </h3>
              <div className="space-y-1">
                {group.shortcuts.map((s) => (
                  <div key={s.key} className="flex items-center justify-between py-1">
                    <span className="text-sm">{s.label}</span>
                    {/* Sans, where "l" cannot be mistaken for "1". */}
                    <kbd className="px-2 py-0.5 text-xs font-sans font-bold border border-border rounded-sm bg-muted">
                      {s.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
