"use client";

import { useCallback, useEffect, useState } from "react";
import { longDate } from "@/components/settings/format";
import { Notice, Panel } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";

/**
 * The Team Business add-on ($49 a month on the team's own subscription):
 * Business features for endpoints shared with the team, 150,000 more
 * requests in the pool, 2,000 pooled parsed pages and 90-day retention. It
 * renews and ends with the team's subscription. The owner adds it through a
 * checkout; bought mid-period it is charged in full and counts at once.
 */
export function TeamBusinessPanel({
  accessToken,
  teamId,
  business,
  canManage,
  onChanged,
}: {
  accessToken: string | null;
  teamId: string;
  business: boolean;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ending, setEnding] = useState<{ ending: boolean; periodEnd: string | null } | null>(null);
  const returned =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("capacity") === "business";

  const loadState = useCallback(async () => {
    if (!accessToken || !canManage || !business) return;
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(teamId)}/billing/business`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) setEnding((await response.json()) as typeof ending);
    } catch {
      // The buttons fall back to both choices.
    }
  }, [accessToken, canManage, business, teamId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const act = async (action: "add" | "end" | "keep") => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/teams/${encodeURIComponent(teamId)}/billing/business`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Request failed (${response.status})`);
      }
      if (response.status === 200) {
        const { url } = (await response.json()) as { url: string };
        window.location.assign(url);
        return;
      }
      setNotice(
        action === "end"
          ? "Team Business ends with the current period, and the team's extra parsed pages with it."
          : "Team Business renews with the team."
      );
      await loadState();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change was not made");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      id="team-business"
      title="Team Business"
      description="Business for the endpoints you share with this team: 150,000 more requests in the pool, 2,000 pooled parsed pages a month, up to 50 layouts per endpoint and 90-day retention. $49 a month, renewed with the team; added mid-period, the first month is charged in full and ends with the team's."
      footer={
        canManage ? (
          business ? (
            ending?.ending ? (
              <Button disabled={busy} onClick={() => void act("keep")}>
                Keep Team Business
              </Button>
            ) : (
              <Button variant="outline" disabled={busy || !ending} onClick={() => void act("end")}>
                End at the renewal
              </Button>
            )
          ) : (
            <Button disabled={busy || !accessToken} onClick={() => void act("add")}>
              Add Team Business, $49 a month
            </Button>
          )
        ) : null
      }
    >
      {returned && !business && (
        <Notice tone="success" title="Thanks">
          Team Business shows here once Polar confirms it, usually within a minute.
        </Notice>
      )}
      <p className="text-sm">
        {!business
          ? "The team has the standard pool: 100,000 requests per seat, 100 parsed pages and 2 layouts per endpoint."
          : ending?.ending
            ? `Team Business ends on ${ending.periodEnd ? longDate(ending.periodEnd) : "the renewal"}; the team keeps the standard pool after that.`
            : "Team Business is on."}
      </p>
      {notice && <p className="text-sm text-muted-foreground mt-2">{notice}</p>}
      {error && (
        <p className="text-sm text-destructive mt-2" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
