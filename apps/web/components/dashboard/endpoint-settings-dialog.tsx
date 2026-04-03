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
    delay?: number;
  };
  /** Current notification webhook URL. null = owned, not set. undefined = shared endpoint (hidden). */
  notificationUrl?: string | null;
}

function TeamSharingSection({
  accessToken,
  endpointId,
}: {
  accessToken: string | null;
  endpointId: string;
}) {
  const [teams, setTeams] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [sharedTeamIds, setSharedTeamIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    const load = async () => {
      try {
        const [teamsRes, endpointsRes] = await Promise.all([
          fetch("/api/teams", { headers: { Authorization: `Bearer ${accessToken}` } }),
          fetch("/api/endpoints", { headers: { Authorization: `Bearer ${accessToken}` } }),
        ]);

        if (teamsRes.ok) {
          const data = (await teamsRes.json()) as Array<{ id: string; name: string; role: string }>;
          setTeams(data);
        }

        if (endpointsRes.ok) {
          const data = (await endpointsRes.json()) as {
            owned: Array<{ id: string; sharedWith?: Array<{ teamId: string }> }>;
          };
          const ep = data.owned.find((e) => e.id === endpointId);
          if (ep?.sharedWith) {
            setSharedTeamIds(new Set(ep.sharedWith.map((s) => s.teamId)));
          }
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [accessToken, endpointId]);

  const handleToggle = async (teamId: string, shared: boolean) => {
    if (!accessToken) return;
    setToggling(teamId);
    try {
      if (shared) {
        const res = await fetch(`/api/teams/${teamId}/endpoints/${endpointId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          setSharedTeamIds((prev) => {
            const next = new Set(prev);
            next.delete(teamId);
            return next;
          });
        }
      } else {
        const res = await fetch(`/api/teams/${teamId}/endpoints`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ endpointId }),
        });
        if (res.ok) {
          setSharedTeamIds((prev) => new Set(prev).add(teamId));
        }
      }
    } catch {
      // silent
    } finally {
      setToggling(null);
    }
  };

  if (loading || teams.length === 0) return null;

  return (
    <div className="border-2 border-foreground p-4 space-y-2">
      <p className="font-bold uppercase tracking-wide text-xs">Team Sharing</p>
      <p className="text-xs text-muted-foreground">Share this endpoint with your teams.</p>
      <div className="space-y-1.5">
        {teams.map((team) => {
          const isShared = sharedTeamIds.has(team.id);
          return (
            <div key={team.id} className="flex items-center justify-between">
              <span className="text-sm">{team.name}</span>
              <button
                onClick={() => handleToggle(team.id, isShared)}
                disabled={toggling === team.id}
                className={`text-xs px-2.5 py-1 border-2 border-foreground transition-colors ${
                  isShared ? "bg-foreground text-background" : "hover:bg-muted"
                }`}
              >
                {toggling === team.id ? "..." : isShared ? "Shared" : "Share"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EndpointSettingsDialog(props: EndpointSettingsDialogProps) {
  const {
    endpointId,
    endpointName,
    slug,
    mockResponse,
    notificationUrl: initialNotificationUrl,
  } = props;
  const { session } = useAuth();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(endpointName);
  const [mockStatus, setMockStatus] = useState(mockResponse?.status?.toString() || "200");
  const [mockBody, setMockBody] = useState(mockResponse?.body || "");
  const [mockDelay, setMockDelay] = useState(mockResponse?.delay?.toString() || "");
  const [delayEnabled, setDelayEnabled] = useState(!!mockResponse?.delay);
  const [notificationUrl, setNotificationUrl] = useState(initialNotificationUrl || "");
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
      setMockDelay(mockResponse?.delay?.toString() || "");
      setDelayEnabled(!!mockResponse?.delay);
      setNotificationUrl(initialNotificationUrl || "");
      setError(null);
      setConfirmDelete(false);
    }
    prevOpen.current = open;
  }, [open, endpointName, mockResponse, initialNotificationUrl]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const accessToken = session?.access_token;
      if (!accessToken) {
        throw new Error("Not authenticated");
      }

      const delayMs = delayEnabled && mockDelay ? parseInt(mockDelay, 10) : undefined;
      const hasCustomMock = mockBody || mockStatus !== "200" || (delayMs && delayMs > 0);
      const updates: Record<string, unknown> = {
        name: name || undefined,
        mockResponse: hasCustomMock
          ? {
              status: parseStatusCode(mockStatus, 200),
              body: mockBody,
              headers: mockResponse?.headers || {},
              ...(delayMs && delayMs > 0 ? { delay: delayMs } : {}),
            }
          : null,
      };
      // Only send notificationUrl if the user owns the endpoint (prop was defined).
      // Shared endpoints don't include notificationUrl — sending null would wipe it.
      if (initialNotificationUrl !== undefined) {
        updates.notificationUrl = notificationUrl || null;
      }
      await updateDashboardEndpoint(accessToken, slug, updates);
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
      <DialogContent className="border-2 border-foreground shadow-neo max-h-[90vh] overflow-y-auto max-w-lg sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-bold uppercase tracking-wide">Endpoint Settings</DialogTitle>
          <DialogDescription>Configure {endpointName || slug}</DialogDescription>
        </DialogHeader>

        {/* Two-column layout on desktop, single column on mobile */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Left column: Mock Response */}
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
                  if (!mockBody || DEFAULT_BODY_VALUES.has(mockBody)) {
                    setMockBody(DEFAULT_BODIES[code] ?? "");
                  }
                }}
              />

              <div className="space-y-2">
                <Label
                  htmlFor="settings-body"
                  className="font-bold uppercase tracking-wide text-xs"
                >
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

              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={delayEnabled}
                    onChange={(e) => {
                      setDelayEnabled(e.target.checked);
                      if (!e.target.checked) setMockDelay("");
                    }}
                    className="accent-foreground"
                  />
                  <span className="font-bold uppercase tracking-wide text-xs">Response Delay</span>
                </label>
                {delayEnabled && (
                  <>
                    <input
                      id="settings-delay"
                      type="number"
                      min="0"
                      max="30000"
                      step="100"
                      value={mockDelay}
                      onChange={(e) => setMockDelay(e.target.value)}
                      onBlur={() => {
                        if (!mockDelay) return;
                        const n = parseInt(mockDelay, 10);
                        if (isNaN(n) || n < 0) setMockDelay("");
                        else if (n > 30000) setMockDelay("30000");
                      }}
                      placeholder="0-30000ms"
                      className="neo-input w-full text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Delay before sending the response (max 30s). Useful for testing timeouts.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right column: Advanced settings */}
          <div className="space-y-4">
            <p className="font-bold uppercase tracking-wide text-xs">Advanced Settings</p>

            <div className="space-y-4">
              {/* Notification Webhook — only shown for owned endpoints */}
              {initialNotificationUrl !== undefined && (
                <div className="border-2 border-foreground p-4 space-y-2">
                  <div>
                    <p className="font-bold uppercase tracking-wide text-xs mb-1">
                      Notification Webhook
                    </p>
                    <p className="text-xs text-muted-foreground">
                      POST a JSON summary to Slack, Discord, or any URL when a request arrives.
                    </p>
                  </div>
                  <input
                    id="settings-notification-url"
                    type="url"
                    value={notificationUrl}
                    onChange={(e) => setNotificationUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    className="neo-input w-full text-sm"
                  />
                </div>
              )}

              {/* Team Sharing */}
              <TeamSharingSection
                accessToken={session?.access_token ?? null}
                endpointId={endpointId}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="border-2 border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

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
