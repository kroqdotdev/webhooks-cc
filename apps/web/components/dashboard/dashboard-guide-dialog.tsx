"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  HelpCircle,
  Keyboard,
  Star,
  StickyNote,
  GitCompareArrows,
  BarChart3,
  Copy,
  Play,
  MousePointer,
  GripVertical,
  Eye,
  Settings,
  Users,
} from "lucide-react";

interface Section {
  id: string;
  title: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    icon: <Eye className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          The dashboard is a split-pane view for inspecting captured webhook requests in real time.
          The left pane shows the request list, the right pane shows the detail for the selected
          request.
        </p>
        <p>
          Requests appear instantly via real-time subscription. Use <Kbd>Live</Kbd> /{" "}
          <Kbd>Paused</Kbd> mode to control whether new requests auto-select.
        </p>
      </div>
    ),
  },
  {
    id: "keyboard",
    title: "Keyboard Shortcuts",
    icon: <Keyboard className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-2">
        <p>Navigate the dashboard without touching the mouse.</p>
        <ShortcutTable
          shortcuts={[
            ["j / k", "Navigate request list down / up"],
            ["1 / 2 / 3 / 4", "Switch to Body / Headers / Query / Raw tab"],
            ["c", "Copy cURL command for selected request"],
            ["r", "Open replay dialog"],
            ["n", "Create new endpoint"],
            ["/", "Focus search input"],
            ["l", "Toggle live / paused mode"],
            ["[", "Toggle sidebar collapse"],
            ["?", "Show keyboard shortcuts dialog"],
            ["Esc", "Close dialog, exit compare mode, or blur input"],
          ]}
        />
      </div>
    ),
  },
  {
    id: "context-menu",
    title: "Context Menu",
    icon: <MousePointer className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          <strong>Right-click</strong> any request in the list to open a context menu with actions:
        </p>
        <ul className="space-y-1.5 text-sm">
          <li className="flex items-center gap-2">
            <Star className="h-3 w-3 shrink-0" /> <strong>Pin / Unpin</strong> — pinned requests
            float to the top of the list
          </li>
          <li className="flex items-center gap-2">
            <GitCompareArrows className="h-3 w-3 shrink-0" /> <strong>Compare with selected</strong>{" "}
            — opens side-by-side diff view
          </li>
          <li className="flex items-center gap-2">
            <Copy className="h-3 w-3 shrink-0" /> <strong>Copy request ID</strong> — copies the full
            ID to clipboard
          </li>
        </ul>
      </div>
    ),
  },
  {
    id: "pinning",
    title: "Pinning Requests",
    icon: <Star className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          Pin important requests so they stay at the top of the list regardless of sort order.
          Useful for reference payloads or known-good requests.
        </p>
        <ul className="space-y-1 text-sm">
          <li>Right-click a request and select &quot;Pin&quot;</li>
          <li>Pinned requests appear in a &quot;Pinned&quot; section at the top</li>
          <li>Pins are saved per endpoint in your browser</li>
          <li>Right-click again to unpin</li>
        </ul>
      </div>
    ),
  },
  {
    id: "notes",
    title: "Request Notes",
    icon: <StickyNote className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          Attach short notes to any request — useful for debugging breadcrumbs or labeling payloads.
        </p>
        <ul className="space-y-1 text-sm">
          <li>
            Select a request, then click <strong>&quot;Add note...&quot;</strong> below the detail
            header
          </li>
          <li>Type your note (max 280 characters) and press Enter</li>
          <li>
            Requests with notes show a <StickyNote className="inline h-3 w-3" /> icon in the list
          </li>
          <li>Click the note to edit, or the X to remove it</li>
          <li>Notes are saved in your browser</li>
        </ul>
      </div>
    ),
  },
  {
    id: "compare",
    title: "Comparing Requests",
    icon: <GitCompareArrows className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          Compare two requests side by side to spot differences in headers, body, and query params.
        </p>
        <ul className="space-y-1 text-sm">
          <li>
            <strong>Shift-click</strong> a second request in the list, or use the context menu
          </li>
          <li>
            The detail pane shows a diff view with color-coded changes: green (added), red
            (removed), yellow (changed)
          </li>
          <li>JSON bodies are compared structurally (key by key)</li>
          <li>
            Exit by pressing <Kbd>Esc</Kbd>, shift-clicking the compared request again, or the Exit
            button in the diff header
          </li>
        </ul>
      </div>
    ),
  },
  {
    id: "timeline",
    title: "Timeline View",
    icon: <BarChart3 className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>
          Switch to a visual timeline of requests, useful for spotting retry storms and timing
          patterns.
        </p>
        <ul className="space-y-1 text-sm">
          <li>
            Click the <BarChart3 className="inline h-3 w-3" /> icon in the toolbar to toggle between
            list and timeline views
          </li>
          <li>Each dot represents a request, color-coded by HTTP method</li>
          <li>Hover for details, click to select</li>
          <li>Overlapping requests stack vertically</li>
        </ul>
      </div>
    ),
  },
  {
    id: "resizable",
    title: "Resizable Pane",
    icon: <GripVertical className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>Customize the split-pane layout to your preference.</p>
        <ul className="space-y-1 text-sm">
          <li>
            <strong>Drag</strong> the divider between the list and detail panes to resize
          </li>
          <li>
            <strong>Double-click</strong> the divider to collapse/expand the sidebar
          </li>
          <li>
            Press <Kbd>[</Kbd> to toggle the sidebar
          </li>
          <li>Your preferred width is remembered across sessions</li>
        </ul>
      </div>
    ),
  },
  {
    id: "copy",
    title: "Copy & Export",
    icon: <Copy className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>Multiple ways to copy and export request data.</p>
        <ul className="space-y-1 text-sm">
          <li>
            <strong>cURL</strong> button — copies a curl command that reproduces the request
          </li>
          <li>
            <strong>Copy dropdown</strong> in the body tab — copy as raw, formatted, TypeScript
            interface, or CSV
          </li>
          <li>
            <strong>Export</strong> dropdown in the URL bar — export all requests as JSON or CSV
          </li>
          <li>
            Press <Kbd>c</Kbd> to quickly copy the cURL command
          </li>
        </ul>
      </div>
    ),
  },
  {
    id: "replay",
    title: "Replay & Send",
    icon: <Play className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>Re-send captured requests or send test webhooks.</p>
        <ul className="space-y-1 text-sm">
          <li>
            <strong>Replay</strong> button — sends the captured request to any URL from your browser
          </li>
          <li>
            <strong>Send</strong> button in the URL bar — send test webhooks with provider templates
            (Stripe, GitHub, etc.)
          </li>
          <li>
            Press <Kbd>r</Kbd> to open replay, <Kbd>n</Kbd> to create a new endpoint
          </li>
        </ul>
      </div>
    ),
  },
  {
    id: "settings",
    title: "Endpoint Settings",
    icon: <Settings className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>Configure how your endpoint responds to incoming webhooks.</p>
        <ul className="space-y-1 text-sm">
          <li>
            Click the <Settings className="inline h-3 w-3" /> gear icon in the URL bar
          </li>
          <li>
            <strong>Mock response</strong> — set a custom status code, headers, and body to return
          </li>
          <li>
            <strong>Rename</strong> your endpoint for easier identification
          </li>
          <li>Changes take effect immediately (no caching layer)</li>
        </ul>
      </div>
    ),
  },
  {
    id: "teams",
    title: "Teams",
    icon: <Users className="h-3.5 w-3.5" />,
    content: (
      <div className="space-y-3">
        <p>Share endpoints with your team so everyone can view incoming requests together.</p>
        <ul className="space-y-1.5 text-sm">
          <li>
            Shared endpoints appear in the endpoint switcher under{" "}
            <strong>&quot;Shared with me&quot;</strong> with the team name
          </li>
          <li>
            Your own shared endpoints show as{" "}
            <strong>&quot;slug (Shared with TeamName)&quot;</strong>
          </li>
          <li>Team members can view requests, edit mock responses, and rename endpoints</li>
          <li>Real-time updates work — new requests appear instantly for all team members</li>
          <li>
            Manage teams from the <strong>Teams</strong> page (avatar dropdown → Teams)
          </li>
          <li>
            Share endpoints from <strong>Endpoint Settings</strong> → Team Sharing section
          </li>
        </ul>
      </div>
    ),
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 text-[10px] font-mono font-bold border-2 border-foreground bg-muted inline-block">
      {children}
    </kbd>
  );
}

function ShortcutTable({ shortcuts }: { shortcuts: [string, string][] }) {
  return (
    <div className="space-y-1">
      {shortcuts.map(([key, label]) => (
        <div key={key} className="flex items-center justify-between py-0.5">
          <span className="text-sm">{label}</span>
          <Kbd>{key}</Kbd>
        </div>
      ))}
    </div>
  );
}

export function DashboardGuideDialog() {
  const [activeSection, setActiveSection] = useState("overview");

  const current = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          data-shortcut="guide"
          className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          Guide
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl h-[520px] max-h-[80vh] p-0 overflow-hidden">
        <div className="flex h-full">
          {/* Sidebar */}
          <nav className="w-48 shrink-0 border-r-2 border-foreground overflow-y-auto py-4">
            <DialogHeader className="px-4 pb-3">
              <DialogTitle className="text-sm uppercase tracking-wide">Dashboard Guide</DialogTitle>
            </DialogHeader>
            <div className="space-y-0.5">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    "w-full px-4 py-1.5 text-left text-xs font-bold uppercase tracking-wide flex items-center gap-2 cursor-pointer transition-colors",
                    activeSection === section.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                >
                  {section.icon}
                  {section.title}
                </button>
              ))}
            </div>
          </nav>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            <h2 className="text-lg font-bold uppercase tracking-wide mb-4 flex items-center gap-2">
              {current.icon}
              {current.title}
            </h2>
            <div className="text-sm leading-relaxed">{current.content}</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
