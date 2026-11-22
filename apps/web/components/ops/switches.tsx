"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, shortDateTime } from "@/lib/support/client";
import type { OpsSwitch } from "@/lib/ops/switches";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";

type SwitchView = OpsSwitch & {
  label: string;
  offText: string;
  configured: boolean;
  changedByEmail: string | null;
};

/** Shortest reason the route takes (reasonOf in lib/tunnels/ops-request.ts). */
const MIN_REASON = 3;

/**
 * Features staff turn off for everyone (lib/ops/switches.ts). Each change
 * asks why, and the page shows the last change.
 */
export function OpsSwitches() {
  const { token } = useOps();
  const { session } = useAuth();
  const me = session?.user.id ?? null;
  const [switches, setSwitches] = useState<SwitchView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ switches: SwitchView[] }>(token, "/api/ops/switches");
      setSwitches(data.switches);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Switches could not be loaded.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (entry: SwitchView) => {
    setBusy(entry.name);
    setError(null);
    setNotice(null);
    try {
      const answer = await apiFetch<{ changed: boolean }>(token, "/api/ops/switches", {
        method: "POST",
        json: { name: entry.name, off: !entry.off, reason: reasons[entry.name] ?? "" },
      });
      setReasons((current) => ({ ...current, [entry.name]: "" }));
      if (!answer.changed) {
        // Another tab or staff member got there first.
        setNotice(`${entry.label} was already ${entry.off ? "on" : "off"}. Nothing changed.`);
      }
      await load();
    } catch (changeError) {
      setError(
        changeError instanceof Error ? changeError.message : "The switch could not be changed."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-4 p-6 lg:p-8">
      <h1 className="text-lg font-semibold">Switches</h1>
      <p className="max-w-[70ch] text-sm text-muted-foreground">
        Turn a feature off for every account at once, without a deploy. The database refuses what a
        switch stops at once; the dashboard and the API stop offering it within 10 seconds.
      </p>
      <div aria-live="polite">
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      </div>
      <div role="alert">
        {error && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive-ink">{error}</p>
            {!switches && (
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
      {!switches ? (
        error ? null : (
          <div role="status" aria-label="Loading">
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        )
      ) : (
        <ul className="space-y-3">
          {switches.map((entry) => {
            const reason = (reasons[entry.name] ?? "").trim();
            const reasonId = `switch-${entry.name}-reason`;
            const hintId = `${reasonId}-hint`;
            const who =
              entry.changedBy === null
                ? ""
                : entry.changedBy === me
                  ? " by you"
                  : ` by ${entry.changedByEmail ?? "another staff member"}`;
            return (
              <Card key={entry.name} className="space-y-3" render={<li />}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-medium">{entry.label}</h2>
                  <span
                    className={cn(
                      "text-sm font-medium",
                      entry.off ? "text-destructive-ink" : "text-primary"
                    )}
                  >
                    {entry.off ? "Off" : "On"}
                  </span>
                </div>
                <p className="max-w-[70ch] text-sm text-muted-foreground">Off: {entry.offText}</p>
                {!entry.configured && (
                  <p className="text-sm text-muted-foreground">
                    Not set up on this server (no API key), so it is off whatever this switch says.
                  </p>
                )}
                {entry.changedAt && entry.reason && (
                  <p className="text-sm ph-no-capture">
                    <span className="text-muted-foreground">
                      {entry.off ? "Turned off" : "Turned on"}
                      {who}, {shortDateTime(entry.changedAt)}:
                    </span>{" "}
                    {entry.reason}
                  </p>
                )}
                <form
                  className="flex flex-wrap items-start gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void change(entry);
                  }}
                >
                  <div className="min-w-64 flex-1 space-y-1">
                    <label htmlFor={reasonId} className="text-xs text-muted-foreground">
                      Why, in a few words
                    </label>
                    <Input
                      id={reasonId}
                      aria-describedby={hintId}
                      value={reasons[entry.name] ?? ""}
                      maxLength={300}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [entry.name]: event.target.value }))
                      }
                    />
                    <p id={hintId} className="text-xs text-muted-foreground">
                      At least {MIN_REASON} characters. Kept with the change and in the audit log.
                    </p>
                  </div>
                  <Button
                    type="submit"
                    className="mt-5"
                    variant={entry.off ? "default" : "destructive"}
                    disabled={busy !== null || reason.length < MIN_REASON}
                  >
                    {busy === entry.name ? "Saving..." : entry.off ? "Turn back on" : "Turn off"}
                  </Button>
                </form>
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
