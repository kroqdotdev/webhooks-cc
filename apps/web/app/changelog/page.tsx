"use client";

import { useState } from "react";
import {
  APP_VERSION,
  CLI_VERSION,
  SDK_VERSION,
  MCP_VERSION,
  CHANGELOG,
  TRACK_LABELS,
  type ChangelogTrack,
} from "@/lib/changelog";

const TRACKS: (ChangelogTrack | "all")[] = ["all", "web", "cli", "sdk", "mcp"];

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ChangelogPage() {
  const [activeTrack, setActiveTrack] = useState<ChangelogTrack | "all">("all");

  const filtered =
    activeTrack === "all"
      ? [...CHANGELOG].sort((a, b) => b.date.localeCompare(a.date))
      : CHANGELOG.filter((e) => e.track === activeTrack);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 pt-28 pb-16">
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight mb-4">Changelog</h1>
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>
              Web <span className="font-mono font-bold text-foreground">v{APP_VERSION}</span>
            </span>
            <span>
              CLI <span className="font-mono font-bold text-foreground">v{CLI_VERSION}</span>
            </span>
            <span>
              SDK <span className="font-mono font-bold text-foreground">v{SDK_VERSION}</span>
            </span>
            <span>
              MCP <span className="font-mono font-bold text-foreground">v{MCP_VERSION}</span>
            </span>
          </div>
        </div>

        <div className="flex gap-2 mb-8 flex-wrap">
          {TRACKS.map((track) => (
            <button
              key={track}
              onClick={() => setActiveTrack(track)}
              className={`px-3 py-1.5 text-xs font-bold caps border-strong border-line rounded-md transition-colors ${
                activeTrack === track
                  ? "bg-selected text-selected-foreground"
                  : "bg-background text-foreground hover:bg-muted"
              }`}
            >
              {track === "all" ? "All" : TRACK_LABELS[track]}
            </button>
          ))}
        </div>

        <div className="space-y-8">
          {filtered.map((entry) => (
            <article
              key={`${entry.track}-${entry.version}`}
              id={`${entry.track}-v${entry.version}`}
              className="border-strong border-line rounded-lg p-6"
            >
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-bold caps-wide px-1.5 py-0.5 border border-line rounded-sm">
                      {TRACK_LABELS[entry.track]}
                    </span>
                    <span className="font-mono text-sm font-bold">v{entry.version}</span>
                  </div>
                  <h2 className="text-lg font-bold">{entry.title}</h2>
                </div>
                <time
                  dateTime={entry.date}
                  className="text-sm text-muted-foreground whitespace-nowrap"
                >
                  {formatDate(entry.date)}
                </time>
              </div>
              <ul className="space-y-1.5">
                {entry.items.map((item, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex gap-2">
                    <span className="text-foreground shrink-0">&bull;</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-12">
            No changelog entries for this track yet.
          </p>
        )}
      </div>
    </main>
  );
}
