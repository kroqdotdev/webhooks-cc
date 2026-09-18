"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { Plus } from "lucide-react";
import { parseStatusCode } from "@/lib/http";
import { trackEndpointCreated } from "@/lib/analytics";
import { createDashboardEndpoint, emitDashboardEndpointsChanged } from "@/lib/dashboard-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";

/** Dialog for creating a new webhook endpoint with optional mock response configuration. */
export function NewEndpointDialog() {
  const { session } = useAuth();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
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
      setOpen(false);
      resetForm();
      router.push(`/dashboard?endpoint=${result.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create endpoint");
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setName("");
    setMockStatus("200");
    setMockBody("");
    setIsSubmitting(false);
    setError(null);
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetForm();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          data-shortcut="new-endpoint"
          className="ui-btn-primary py-1.5! px-3! text-xs flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          New Endpoint
        </button>
      </DialogTrigger>
      <DialogContent className="border-strong border-line shadow-raised">
        <DialogHeader>
          <DialogTitle className="font-bold caps">Create Endpoint</DialogTitle>
          <DialogDescription>Create a new webhook endpoint to capture requests.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ep-name" className="font-bold caps text-xs">
              Name (optional)
            </Label>
            <input
              id="ep-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
              className="ui-input w-full text-sm"
            />
          </div>

          <div className="border-strong border-line rounded-lg p-4 space-y-4">
            <div>
              <p className="font-bold caps text-xs mb-1">Mock Response (optional)</p>
              <p className="text-xs text-muted-foreground">
                Configure what this endpoint returns when it receives a request.
              </p>
            </div>

            <StatusCodePicker id="ep-status" value={mockStatus} onChange={setMockStatus} />

            <div className="space-y-2">
              <Label htmlFor="ep-body" className="font-bold caps text-xs">
                Response Body
              </Label>
              <Textarea
                id="ep-body"
                value={mockBody}
                onChange={(e) => setMockBody(e.target.value)}
                placeholder='{"success": true}'
                rows={3}
                className="border-strong border-line text-sm font-mono"
              />
            </div>
          </div>

          {error && (
            <div className="border-strong border-destructive rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <Button
              type="submit"
              disabled={isSubmitting || !session?.access_token}
              className="ui-btn-primary flex-1"
            >
              {isSubmitting ? "Creating..." : "Create Endpoint"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="ui-btn-outline"
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
