"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, shortDateTime, waitLabel } from "@/lib/support/client";
import type { HeldRefund } from "@/lib/ops/refunds";
import { cn } from "@/lib/utils";
import { useOps } from "./ops-shell";

const REASONS: Record<string, string> = {
  duplicate_plan: "A second plan subscription",
  duplicate_addon: "A second add-on subscription",
  deleted_account: "Paid after the account or team was deleted",
  addon_not_applied: "An add-on that could not be applied",
  addon_ended: "An add-on that ended with its plan",
};

const HOLDS: Record<string, string> = {
  manual: "Automatic refunds are off",
  over_cap: "Above the automatic refund cap",
  old_orders: "Includes orders older than two days",
};

function dollars(cents: number | null): string {
  return cents === null ? "–" : `$${(cents / 100).toFixed(2)}`;
}

/** Held refunds: what approving would refund, and the two decisions. */
export function OpsRefunds() {
  const { token } = useOps();
  const [view, setView] = useState<"held" | "recent">("held");
  const [data, setData] = useState<{ installed: boolean; refunds: HeldRefund[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch(token, `/api/ops/refunds?view=${view}`));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Refunds could not be loaded.");
    }
  }, [token, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, decision: "approve" | "dismiss") => {
    setBusy(id);
    try {
      await apiFetch(token, `/api/ops/refunds/${id}`, { method: "POST", json: { decision } });
      await load();
    } catch (decideError) {
      setError(
        decideError instanceof Error ? decideError.message : "The decision could not be saved."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-4xl space-y-4 p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Refunds</h1>
        <div className="flex gap-1 text-xs">
          {(["held", "recent"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={cn(
                "rounded-md px-2 py-1",
                view === value
                  ? "bg-selected font-medium text-selected-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {value === "held" ? "Waiting for you" : "Decided"}
            </button>
          ))}
        </div>
      </div>
      <p className="max-w-[70ch] text-sm text-muted-foreground">
        Approving hands a refund to the refund worker, which refunds exactly the orders listed,
        before tax. Refunds move money and cannot be undone.
      </p>
      {error && <p className="text-sm text-destructive-ink">{error}</p>}
      {!data ? (
        <Skeleton className="h-32 w-full rounded-md" />
      ) : !data.installed ? (
        <p className="ui-card ui-card-static text-sm text-muted-foreground">
          The refund queue is not in this database yet. It arrives with the automatic refunds
          migration.
        </p>
      ) : data.refunds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {view === "held" ? "No refund is waiting for a decision." : "No decided refunds yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {data.refunds.map((refund) => (
            <li key={refund.id} className="ui-card ui-card-static space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {dollars(refund.plannedCents)}{" "}
                  <span className="font-normal text-muted-foreground">
                    {REASONS[refund.reason] ?? refund.reason}
                  </span>
                </p>
                <span className="text-xs text-muted-foreground">
                  {refund.status === "held" || refund.status === "failed"
                    ? `${refund.status === "failed" ? "Failed" : "Held"} ${waitLabel(refund.createdAt)}`
                    : `${refund.status}${refund.finishedAt ? `, ${shortDateTime(refund.finishedAt)}` : ""}`}
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="ph-no-capture">
                  {refund.account ? (
                    refund.account.kind === "user" ? (
                      <Link href={`/ops/accounts/${refund.account.id}`} className="hover:underline">
                        {refund.account.label}
                      </Link>
                    ) : (
                      `Team ${refund.account.label}`
                    )
                  ) : (
                    "Unknown"
                  )}
                </dd>
                {refund.holdReason && (
                  <>
                    <dt className="text-muted-foreground">Held because</dt>
                    <dd>{HOLDS[refund.holdReason] ?? refund.holdReason}</dd>
                  </>
                )}
                {refund.lastError && (
                  <>
                    <dt className="text-muted-foreground">Last error</dt>
                    <dd className="font-mono text-xs text-destructive-ink">{refund.lastError}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Orders</dt>
                <dd>
                  {refund.orders.length === 0 ? (
                    <span className="text-muted-foreground">
                      Not prepared yet; the worker reads them from Polar.
                    </span>
                  ) : (
                    <ul className="space-y-0.5">
                      {refund.orders.map((order) => (
                        <li key={order.orderId} className="font-mono text-xs">
                          {order.orderId} {dollars(order.netCents)}
                          {order.billingReason ? `, ${order.billingReason}` : ""}
                          {order.createdAt ? `, ${shortDateTime(order.createdAt)}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
              {(refund.status === "held" || refund.status === "failed") && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy === refund.id || refund.orders.length === 0}
                    onClick={() => void decide(refund.id, "approve")}
                  >
                    Approve {dollars(refund.plannedCents)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === refund.id}
                    onClick={() => void decide(refund.id, "dismiss")}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SavedReply {
  id: string;
  title: string;
  body: string;
}

/** Reusable answers. {{name}} and {{plan}} are filled in when inserted. */
export function SavedReplies() {
  const { token } = useOps();
  const [replies, setReplies] = useState<SavedReply[] | null>(null);
  const [editing, setEditing] = useState<
    SavedReply | { id: null; title: string; body: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReplies(await apiFetch<SavedReply[]>(token, "/api/ops/saved-replies"));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Saved replies could not be loaded."
      );
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!editing) return;
    try {
      await apiFetch(
        token,
        editing.id ? `/api/ops/saved-replies/${editing.id}` : "/api/ops/saved-replies",
        {
          method: editing.id ? "PATCH" : "POST",
          json: { title: editing.title, body: editing.body },
        }
      );
      setEditing(null);
      setError(null);
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "The saved reply could not be saved."
      );
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(token, `/api/ops/saved-replies/${id}`, { method: "DELETE" });
      await load();
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : "The saved reply could not be deleted."
      );
    }
  };

  return (
    <div className="max-w-3xl space-y-4 p-6 lg:p-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Saved replies</h1>
        <Button size="sm" onClick={() => setEditing({ id: null, title: "", body: "" })}>
          New saved reply
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Insert one from a ticket with <kbd className="font-mono">/</kbd>. Write{" "}
        <code className="font-mono">{"{{name}}"}</code> for the person&rsquo;s first name and{" "}
        <code className="font-mono">{"{{plan}}"}</code> for their plan.
      </p>
      {error && <p className="text-sm text-destructive-ink">{error}</p>}
      {editing && (
        <div className="ui-card ui-card-static space-y-3">
          <label htmlFor="reply-title" className="text-sm font-medium">
            Title
          </label>
          <Input
            id="reply-title"
            value={editing.title}
            maxLength={120}
            onChange={(event) => setEditing({ ...editing, title: event.target.value })}
          />
          <label htmlFor="reply-body" className="text-sm font-medium">
            Text
          </label>
          <Textarea
            id="reply-body"
            value={editing.body}
            rows={6}
            onChange={(event) => setEditing({ ...editing, body: event.target.value })}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {replies === null ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : replies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved replies yet.</p>
      ) : (
        <ul className="ui-card ui-card-static p-0! overflow-hidden">
          {replies.map((reply) => (
            <li
              key={reply.id}
              className="flex items-start justify-between gap-4 border-t border-border px-4 py-3 first:border-t-0"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{reply.title}</p>
                <p className="line-clamp-2 text-xs text-muted-foreground">{reply.body}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(reply)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(reply.id)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
