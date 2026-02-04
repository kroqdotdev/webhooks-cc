"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Id } from "@convex/_generated/dataModel";
import { EndpointSettingsDialog } from "./endpoint-settings-dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { WEBHOOK_BASE_URL } from "@/lib/constants";

interface UrlBarProps {
  endpointId: Id<"endpoints">;
  endpointName: string;
  slug: string;
  mockResponse?: {
    status: number;
    body: string;
    headers: Record<string, string>;
  };
  extra?: React.ReactNode;
}

export function UrlBar({ endpointId, endpointName, slug, mockResponse, extra }: UrlBarProps) {
  const [copied, setCopied] = useState(false);
  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;

  const copyUrl = async () => {
    const success = await copyToClipboard(url);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="border-b-2 border-foreground bg-card px-4 py-3 shrink-0">
      <div className="flex items-center gap-3">
        {/* Settings + Name */}
        <EndpointSettingsDialog
          endpointId={endpointId}
          endpointName={endpointName}
          slug={slug}
          mockResponse={mockResponse}
        />
        <span className="font-bold text-sm uppercase tracking-wide shrink-0">{endpointName}</span>

        {/* URL + Copy */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <code
            className="font-mono text-sm text-muted-foreground truncate cursor-pointer hover:text-foreground transition-colors"
            onClick={copyUrl}
            title="Click to copy"
          >
            {url}
          </code>
          <button
            onClick={copyUrl}
            className="p-1.5 hover:bg-muted transition-colors cursor-pointer border-2 border-foreground shrink-0"
            title="Copy URL"
            aria-label="Copy webhook URL"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        {extra}
      </div>
    </div>
  );
}
