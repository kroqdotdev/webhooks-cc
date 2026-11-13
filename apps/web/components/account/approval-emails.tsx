"use client";

import { useCallback, useEffect, useState } from "react";
import { SwitchRow } from "@/components/dashboard/settings-primitives";
import { InlineMessage, Panel } from "@/components/settings/panel";
import { createClient } from "@/lib/supabase/client";

/**
 * The opt-in email for every approval an agent or API key asks for (a new
 * API key, say). Off by default: the asker shows the link itself, and the
 * email is for agents that run where nobody sees it, such as CI.
 */
export function ApprovalEmails({
  userId,
  accessToken,
}: {
  userId: string | null;
  accessToken: string | null;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadFailed, setLoadFailed] = useState(false);

  // The switch stays off-limits until the stored value is known: showing
  // "off" after a failed read would misstate a setting that is on.
  const load = useCallback(() => {
    if (!userId) return;
    setLoadFailed(false);
    createClient()
      .from("users")
      .select("approval_emails")
      .eq("id", userId)
      .single<{ approval_emails: boolean }>()
      .then(({ data, error: readError }) => {
        if (readError || !data) setLoadFailed(true);
        else setEnabled(data.approval_emails);
      });
  }, [userId]);

  useEffect(() => load(), [load]);

  const change = async (next: boolean) => {
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ approvalEmails: next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save that.");
      }
    } catch (err) {
      setEnabled(previous);
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Approvals">
      <SwitchRow
        id="approval-emails"
        label="Email me when an agent asks for approval"
        help="An agent or API key that wants something only you may allow, such as a new API key, gets a link for you to open. With this on, you also get that link by email, which helps when the agent runs where nobody sees its output."
        checked={enabled ?? false}
        disabled={enabled === null || saving}
        onChange={(next) => void change(next)}
      />
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {loadFailed && (
        <InlineMessage tone="error">
          Could not read this setting.{" "}
          <button type="button" className="underline" onClick={load}>
            Try again
          </button>
        </InlineMessage>
      )}
    </Panel>
  );
}
