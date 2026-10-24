"use client";

import { Braces } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * "Insert field": a menu of `{{ ... }}` placeholders for a template input,
 * so nobody has to remember the names. The groups come from the caller
 * (a mock response reads the HTTP request; a forwarded email its JSON).
 */

export interface PlaceholderChoice {
  label: string;
  /** What is inserted, braces included. */
  text: string;
}

export interface PlaceholderGroup {
  label: string;
  choices: PlaceholderChoice[];
}

/** What a mock response (and a forwarded HTTP request) can read. */
export const REQUEST_PLACEHOLDERS: PlaceholderGroup[] = [
  {
    label: "From the request",
    choices: [
      { label: "A body field", text: "{{ json.id }}" },
      { label: "The whole body", text: "{{ body }}" },
      { label: "A header", text: "{{ headers.user-agent }}" },
      { label: "A query parameter", text: "{{ query.page }}" },
      { label: "Method", text: "{{ method }}" },
      { label: "Path", text: "{{ path }}" },
      { label: "Request id", text: "{{ id }}" },
      { label: "Received at", text: "{{ receivedAt }}" },
    ],
  },
  {
    label: "Generated",
    choices: [
      { label: "A new UUID", text: "{{ uuid }}" },
      { label: "The current time", text: "{{ now }}" },
    ],
  },
];

/** Inserts `text` into a text input at its cursor (or the end), returning the new value. */
export function insertAtCursor(
  element: HTMLTextAreaElement | HTMLInputElement | null,
  value: string,
  text: string
): { value: string; cursor: number } {
  const start = element?.selectionStart ?? value.length;
  const end = element?.selectionEnd ?? value.length;
  return { value: value.slice(0, start) + text + value.slice(end), cursor: start + text.length };
}

export function PlaceholderMenu({
  groups,
  onInsert,
  label = "Insert field",
}: {
  groups: PlaceholderGroup[];
  onInsert: (text: string) => void;
  label?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5"
        >
          <Braces className="h-3 w-3" />
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 border-strong border-line shadow-raised">
        {groups.map((group, index) => (
          <div key={group.label}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground font-semibold">
              {group.label}
            </DropdownMenuLabel>
            {group.choices.map((choice) => (
              <DropdownMenuItem
                key={choice.text}
                onSelect={() => onInsert(choice.text)}
                className="flex items-baseline justify-between gap-3 cursor-pointer"
              >
                <span className="text-sm">{choice.label}</span>
                <code className="font-mono text-[11px] text-muted-foreground truncate">
                  {choice.text}
                </code>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
