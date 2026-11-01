"use client";

import { useEffect, useState } from "react";
import type { DashboardEndpoint } from "@/lib/dashboard-api";
import { Field, SaveFooter, Section, Segmented, useSave } from "./settings-primitives";

type Mode = "plan" | "shorter" | "delivered";

function modeOf(endpoint: DashboardEndpoint): Mode {
  if (endpoint.deleteAfterDelivery) return "delivered";
  return endpoint.retentionDays ? "shorter" : "plan";
}

/**
 * How long this endpoint keeps what it captures: as long as the plan does,
 * fewer days, or until every destination has its copy ("deliver, then
 * delete"). The plan's retention is the most an endpoint can keep.
 */
export function RetentionSection({ endpoint }: { endpoint: DashboardEndpoint }) {
  const cap = endpoint.retentionCapDays ?? 7;
  const initialMode = modeOf(endpoint);
  const initialDays = endpoint.retentionDays ?? Math.max(1, Math.min(7, cap - 1));
  const [mode, setMode] = useState<Mode>(initialMode);
  const [days, setDays] = useState<string>(String(initialDays));
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);

  useEffect(() => {
    setMode(initialMode);
    setDays(String(initialDays));
  }, [initialMode, initialDays]);

  const parsedDays = Number(days);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= cap;
  const dirty =
    mode !== initialMode ||
    (mode === "shorter" && parsedDays !== (endpoint.retentionDays ?? initialDays));

  return (
    <Section
      id="retention"
      title="Retention"
      description={`How long requests stay here. Your plan keeps them for ${cap} days; any endpoint can keep them for less.`}
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Retention changed."
          onReset={() => {
            setMode(initialMode);
            setDays(String(initialDays));
            setError(null);
            setSaved(false);
          }}
          onSave={() => {
            void save(
              mode === "plan"
                ? { retentionDays: null, deleteAfterDelivery: false }
                : mode === "shorter"
                  ? { retentionDays: parsedDays, deleteAfterDelivery: false }
                  : { retentionDays: null, deleteAfterDelivery: true },
              () => {
                if (mode === "shorter" && !daysValid) {
                  throw new Error(`Enter a number of days from 1 to ${cap}.`);
                }
              }
            );
          }}
        />
      }
    >
      <Segmented<Mode>
        name="Retention"
        value={mode}
        onChange={setMode}
        options={[
          { value: "plan", label: `${cap} days` },
          { value: "shorter", label: "Fewer days" },
          { value: "delivered", label: "Deliver, then delete" },
        ]}
      />
      {mode === "shorter" && (
        <Field
          id="settings-retention-days"
          label="Days to keep"
          error={days !== "" && !daysValid ? `From 1 to ${cap} days.` : undefined}
          help="Requests older than this are deleted within minutes, with their attachments."
        >
          <input
            id="settings-retention-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={cap}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className="ui-input w-28 text-sm py-2!"
          />
        </Field>
      )}
      {mode === "delivered" && (
        <p className="text-xs text-muted-foreground max-w-[62ch]">
          Each request is deleted, with its attachments, a minute after every destination has its
          copy or has given up. An endpoint without destinations keeps nothing past that minute, so
          add one first.
          {(endpoint.destinationCount ?? 0) === 0 && (
            <span className="block mt-1 text-destructive">This endpoint has no destinations.</span>
          )}
        </p>
      )}
    </Section>
  );
}
