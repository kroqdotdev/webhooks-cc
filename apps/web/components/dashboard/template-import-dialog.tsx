"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { addLayoutTemplate, type DashboardEndpoint } from "@/lib/dashboard-api";
import { layoutTemplate } from "@/lib/layout-templates";

/**
 * Adds a ready-made layout from a mailhooks.cc sender page
 * (/dashboard?template=<id>) to one of the account's own endpoints, then
 * opens that endpoint's layouts to try it on a real email.
 */
export function TemplateImportDialog({
  accessToken,
  templateId,
  endpoints,
  onAdded,
  onClose,
}: {
  accessToken: string | null;
  templateId: string;
  /** The account's own endpoints that receive email. */
  endpoints: DashboardEndpoint[];
  onAdded: (slug: string) => void;
  onClose: () => void;
}) {
  const template = layoutTemplate(templateId);
  const [slug, setSlug] = useState(endpoints[0]?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!template) {
    // An old or mistyped link: say so, and let it be dismissed (onClose
    // takes the template out of the URL).
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="border-strong border-line shadow-raised">
          <DialogHeader>
            <DialogTitle className="font-bold">That layout is not available</DialogTitle>
            <DialogDescription>
              The link names a layout this site does not have. Pick one from the sender pages
              instead.
            </DialogDescription>
          </DialogHeader>
          <Button type="button" variant="outline" className="ui-btn-outline" onClick={onClose}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  const add = async () => {
    if (!accessToken || !slug) return;
    setBusy(true);
    setError(null);
    try {
      await addLayoutTemplate(accessToken, slug, template.id);
      onAdded(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The layout could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="border-strong border-line shadow-raised">
        <DialogHeader>
          <DialogTitle className="font-bold">Add the {template.layout.name} layout</DialogTitle>
          <DialogDescription>
            It goes at the end of the endpoint&apos;s layouts. Then send one of your own{" "}
            {template.sender} emails to the endpoint and check it in the preview.
          </DialogDescription>
        </DialogHeader>
        {endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create an endpoint first with New Endpoint, then open this link again.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="template-endpoint" className="font-bold caps text-xs">
              Endpoint
            </Label>
            <select
              id="template-endpoint"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              className="ui-input w-full text-sm"
            >
              {endpoints.map((endpoint) => (
                <option key={endpoint.slug} value={endpoint.slug}>
                  {endpoint.name
                    ? `${endpoint.name} (${endpoint.emailAddress})`
                    : endpoint.emailAddress}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <Button
            type="button"
            className="ui-btn-primary flex-1"
            disabled={busy || !slug || !accessToken}
            onClick={() => void add()}
          >
            {busy ? "Adding..." : "Add layout"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="ui-btn-outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
