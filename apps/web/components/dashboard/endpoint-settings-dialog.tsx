"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import { Settings } from "lucide-react";
import { parseStatusCode } from "@/lib/http";
import {
  deleteDashboardEndpoint,
  emitDashboardEndpointsChanged,
  updateDashboardEndpoint,
} from "@/lib/dashboard-api";
import { trackEndpointDeleted, trackEndpointSaved } from "@/lib/analytics";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Suggested response bodies by status code. Used to pre-fill the body when the user picks a code. */
const DEFAULT_BODIES: Record<string, string> = {
  "200": '{"status": "ok"}',
  "201": '{"id": "abc-123", "created": true}',
  "202": '{"accepted": true, "message": "Processing"}',
  "204": "",
  "301": "",
  "302": "",
  "304": "",
  "307": "",
  "308": "",
  "400": '{"error": "bad_request", "message": "Invalid input"}',
  "401": '{"error": "unauthorized"}',
  "403": '{"error": "forbidden"}',
  "404": '{"error": "not_found"}',
  "405": '{"error": "method_not_allowed"}',
  "409": '{"error": "conflict", "message": "Resource already exists"}',
  "422": '{"error": "unprocessable_entity", "message": "Validation failed"}',
  "429": '{"error": "too_many_requests", "retry_after": 60}',
  "500": '{"error": "internal_server_error"}',
  "502": '{"error": "bad_gateway"}',
  "503": '{"error": "service_unavailable"}',
  "504": '{"error": "gateway_timeout"}',
};

const DEFAULT_BODY_VALUES = new Set(Object.values(DEFAULT_BODIES));

/** Props for the EndpointSettingsDialog component. */
interface EndpointSettingsDialogProps {
  /** Stable endpoint ID. */
  endpointId: string;
  /** Display name of the endpoint. */
  endpointName: string;
  /** URL-safe slug for the endpoint. */
  slug: string;
  /** Current mock response configuration, if set. */
  mockResponse?: {
    status: number;
    body: string;
    headers: Record<string, string>;
  };
}

export function EndpointSettingsDialog(props: EndpointSettingsDialogProps) {
  const { endpointName, slug, mockResponse } = props;
  const { session } = useAuth();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(endpointName);
  const [mockStatus, setMockStatus] = useState(mockResponse?.status?.toString() || "200");
  const [mockBody, setMockBody] = useState(mockResponse?.body || "");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync props only when dialog opens (not on every re-render while open)
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setName(endpointName);
      setMockStatus(mockResponse?.status?.toString() || "200");
      setMockBody(mockResponse?.body || "");
      setError(null);
      setConfirmDelete(false);
    }
    prevOpen.current = open;
  }, [open, endpointName, mockResponse]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      const hasCustomMock = mockBody || mockStatus !== "200";
      await updateDashboardEndpoint(accessToken, slug, {
        name: name || undefined,
        mockResponse: hasCustomMock
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: mockResponse?.headers || {},
            }
          : null,
      });
      emitDashboardEndpointsChanged();
      setOpen(false);

      trackEndpointSaved(
        {
          name: endpointName,
          mockStatus: mockResponse?.status?.toString() || "200",
          mockBody: mockResponse?.body || "",
        },
        { name, mockStatus, mockBody }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setIsDeleting(true);
    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      await deleteDashboardEndpoint(accessToken, slug);
      trackEndpointDeleted();
      emitDashboardEndpointsChanged();
      setOpen(false);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="p-1.5 hover:bg-muted transition-colors cursor-pointer border-2 border-foreground"
          title="Endpoint settings"
          aria-label="Endpoint settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground shadow-neo">
        <DialogHeader>
          <DialogTitle className="font-bold uppercase tracking-wide">Endpoint Settings</DialogTitle>
          <DialogDescription>Configure {endpointName || slug}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="settings-name" className="font-bold uppercase tracking-wide text-xs">
              Name
            </Label>
            <input
              id="settings-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Webhook"
              className="neo-input w-full text-sm"
            />
          </div>

          {/* Mock Response */}
          <div className="border-2 border-foreground p-4 space-y-4">
            <div>
              <p className="font-bold uppercase tracking-wide text-xs mb-1">Mock Response</p>
              <p className="text-xs text-muted-foreground">
                What this endpoint returns when it receives a request.
              </p>
            </div>

            <StatusCodePicker
              id="settings-status"
              value={mockStatus}
              onChange={(code) => {
                setMockStatus(code);
                // Pre-fill body with a sensible default if empty or still a default template
                if (!mockBody || DEFAULT_BODY_VALUES.has(mockBody)) {
                  setMockBody(DEFAULT_BODIES[code] ?? "");
                }
              }}
            />

            <div className="space-y-2">
              <Label htmlFor="settings-body" className="font-bold uppercase tracking-wide text-xs">
                Response Body
              </Label>
              <Textarea
                id="settings-body"
                value={mockBody}
                onChange={(e) => setMockBody(e.target.value)}
                placeholder='{"status": "ok"}'
                rows={3}
                className="border-2 border-foreground rounded-none text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Edit freely &mdash; the suggestion above is just a starting point.
              </p>
            </div>
          </div>

          {error && (
            <div className="border-2 border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between gap-3 pt-2">
          <button
            onClick={handleDelete}
            disabled={isDeleting}
            className={`neo-btn-outline py-1.5! px-3! text-xs ${
              confirmDelete
                ? "bg-destructive! text-destructive-foreground! border-destructive!"
                : "text-destructive"
            }`}
          >
            {isDeleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete Endpoint"}
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => setOpen(false)}
              className="neo-btn-outline py-1.5! px-3! text-xs"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !session?.access_token}
              className="neo-btn-primary py-1.5! px-3! text-xs"
            >
              {isSaving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
