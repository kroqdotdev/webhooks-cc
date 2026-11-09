"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { parseStatusCode } from "@/lib/http";
import { trackEndpointCreated } from "@/lib/analytics";
import { createDashboardEndpoint, emitDashboardEndpointsChanged } from "@/lib/dashboard-api";
import { useSite } from "@/components/providers/site-provider";
import { twoSites, type EndpointSite } from "@/lib/site";
import { cn } from "@/lib/utils";
import { EndpointSiteField } from "./endpoint-site-field";

/** The line under "Create endpoint", in the dialog and on /endpoints/new alike. */
export function newEndpointDescription(mailFirst: boolean): string {
  return mailFirst
    ? "It gets its own email address, and an HTTP URL too."
    : "It gets a URL that captures every request, and an email address too.";
}

/**
 * The create-endpoint form, shared by the New endpoint dialog and the
 * /endpoints/new page so both ask the same things in the same words.
 */
export function NewEndpointForm({
  onCreated,
  cancel,
  autoFocusName = false,
}: {
  /** Puts the cursor in the name field (the dialog, which opens to name an endpoint). */
  autoFocusName?: boolean;
  /** Called with the new endpoint's slug once it exists. */
  onCreated: (slug: string) => void;
  /** The Cancel control: a button in the dialog, a link on the page. */
  cancel: React.ReactNode;
}) {
  const { session } = useAuth();
  const site = useSite();
  const mailFirst = site.key === "mailhooks";

  const [name, setName] = useState("");
  // Listed on the site it is made on unless chosen otherwise.
  const [listedOn, setListedOn] = useState<EndpointSite>(site.key);
  // Where it is listed is rarely changed, so it waits behind "More options".
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const [mockStatus, setMockStatus] = useState("200");
  const [mockBody, setMockBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      const result = await createDashboardEndpoint(accessToken, {
        name: name || undefined,
        ...(twoSites() ? { site: listedOn } : {}),
        mockResponse: mockBody
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: {},
            }
          : undefined,
      });

      trackEndpointCreated();
      emitDashboardEndpointsChanged();
      onCreated(result.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ep-name" className="font-bold caps text-xs">
          Name (optional)
        </Label>
        <input
          id="ep-name"
          autoFocus={autoFocusName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mailFirst ? "Acme orders" : "My webhook"}
          className="ui-input w-full text-sm"
        />
      </div>

      {twoSites() && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setMoreOpen((current) => !current)}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
          >
            More options
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", moreOpen && "rotate-180")}
              aria-hidden
            />
          </button>
          <div id={moreId} hidden={!moreOpen}>
            <EndpointSiteField value={listedOn} onChange={setListedOn} />
          </div>
        </div>
      )}

      {/* A mail-first endpoint rarely answers HTTP; the same setting stays under Settings. */}
      {!mailFirst && (
        <div className="border-strong border-line rounded-lg p-4 space-y-4">
          <div>
            <p className="font-bold caps text-xs mb-1">Mock response (optional)</p>
            <p className="text-xs text-muted-foreground">
              Configure what this endpoint returns when it receives a request.
            </p>
          </div>

          <StatusCodePicker id="ep-status" value={mockStatus} onChange={setMockStatus} />

          <div className="space-y-2">
            <Label htmlFor="ep-body" className="font-bold caps text-xs">
              Response body
            </Label>
            <Textarea
              id="ep-body"
              value={mockBody}
              onChange={(e) => setMockBody(e.target.value)}
              placeholder='{"success": true}'
              rows={3}
              aria-describedby="ep-body-hint"
              className="border-strong border-line text-sm font-mono"
            />
            <p id="ep-body-hint" className="text-xs text-muted-foreground">
              {looksLikeBrokenJson(mockBody) ? (
                <span className="text-destructive-ink">
                  This does not parse as JSON; it will be sent as plain text.
                </span>
              ) : (
                "Sent as written. Headers can be set later under Settings, Responses."
              )}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="border-strong border-destructive rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
        >
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={isSubmitting || !session?.access_token}
          className="ui-btn-primary flex-1"
        >
          {isSubmitting ? "Creating..." : "Create endpoint"}
        </Button>
        {cancel}
      </div>
    </form>
  );
}

/** Text that starts like JSON but does not parse: worth a gentle warning, never a block. */
function looksLikeBrokenJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}
