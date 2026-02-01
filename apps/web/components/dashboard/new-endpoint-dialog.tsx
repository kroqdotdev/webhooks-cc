"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { Plus } from "lucide-react";
import { parseStatusCode } from "@/lib/http";
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
  const router = useRouter();
  const createEndpoint = useMutation(api.endpoints.create);

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
      const result = await createEndpoint({
        name: name || undefined,
        mockResponse: mockBody
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: {},
            }
          : undefined,
      });

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
        <button className="neo-btn-primary !py-1.5 !px-3 text-xs flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New Endpoint
        </button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground shadow-neo">
        <DialogHeader>
          <DialogTitle className="font-bold uppercase tracking-wide">Create Endpoint</DialogTitle>
          <DialogDescription>Create a new webhook endpoint to capture requests.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ep-name" className="font-bold uppercase tracking-wide text-xs">
              Name (optional)
            </Label>
            <input
              id="ep-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
              className="neo-input w-full text-sm"
            />
          </div>

          <div className="border-2 border-foreground p-4 space-y-4">
            <div>
              <p className="font-bold uppercase tracking-wide text-xs mb-1">
                Mock Response (optional)
              </p>
              <p className="text-xs text-muted-foreground">
                Configure what this endpoint returns when it receives a request.
              </p>
            </div>

            <StatusCodePicker id="ep-status" value={mockStatus} onChange={setMockStatus} />

            <div className="space-y-2">
              <Label htmlFor="ep-body" className="font-bold uppercase tracking-wide text-xs">
                Response Body
              </Label>
              <Textarea
                id="ep-body"
                value={mockBody}
                onChange={(e) => setMockBody(e.target.value)}
                placeholder='{"success": true}'
                rows={3}
                className="border-2 border-foreground rounded-none text-sm font-mono"
              />
            </div>
          </div>

          {error && (
            <div className="border-2 border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="neo-btn-primary !rounded-none flex-1"
            >
              {isSubmitting ? "Creating..." : "Create Endpoint"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="neo-btn-outline !rounded-none"
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
