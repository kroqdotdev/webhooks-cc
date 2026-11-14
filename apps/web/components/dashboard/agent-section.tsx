"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardEndpoint } from "@/lib/dashboard-api";
import { parseAgentRepo } from "@/lib/fix-prompt";
import { Field, SaveFooter, Section, useSave } from "./settings-primitives";
import { FieldControl } from "@/components/ui/field";

/**
 * The GitHub repository a coding agent fixes this endpoint's failed
 * deliveries in (endpoints.agent_repo). It picks the project when a failed
 * delivery opens in T3 Code, and turns on the T3 Code link in
 * delivery-failure alert emails. Copy prompt works without it.
 */
export function AgentSection({ endpoint }: { endpoint: DashboardEndpoint }) {
  const initial = endpoint.agentRepo ?? "";
  const [value, setValue] = useState(initial);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  // The saved value the field last showed, and what was last sent: a new
  // saved value replaces the field only when it was not edited since.
  const shown = useRef(initial);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    // Read the refs before the update is queued, so it compares what they
    // held when this value arrived.
    const previous = shown.current;
    const lastSent = sent.current;
    shown.current = initial;
    sent.current = null;
    setValue((current) =>
      asSaved(current) === previous || current === lastSent ? initial : current
    );
  }, [initial]);

  const parsed = parseAgentRepo(value);
  // Compared as it would be saved, so `acme/api.git` beside a saved
  // `acme/api` is no change.
  const dirty = asSaved(value) !== initial;

  return (
    <Section
      id="agent"
      title="Coding agent"
      description="A failed delivery can go to a coding agent in one click: Copy prompt under it, or Open in T3 Code. Name the repository its handler lives in to open T3 Code there and to add the link to alert emails."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint="Repository changed."
          onReset={() => {
            setValue(initial);
            setError(null);
            setSaved(false);
          }}
          onSave={() => {
            const submitted = value;
            sent.current = submitted;
            void save({ agentRepo: parsed.ok ? parsed.value : value }, () => {
              if (!parsed.ok)
                throw new Error("Enter the repository as owner/name, or leave it empty.");
            }).then((ok) => {
              if (!ok) {
                sent.current = null;
                return;
              }
              // Show the saved form (no .git, no spaces) unless it was edited meanwhile.
              setValue((current) => (current === submitted ? asSaved(submitted) : current));
            });
          }}
        />
      }
    >
      <Field
        id="settings-agent-repo"
        label="GitHub repository"
        error={value.trim() !== "" && !parsed.ok ? parsed.error : undefined}
        help="The prompt names the delivery and its request by id, never their contents. The agent reads the rest through the webhooks.cc MCP server or whk. Team members who can view this endpoint see the repository name."
      >
        <FieldControl
          className="ph-no-capture w-full max-w-sm text-sm py-2! font-mono"
          id="settings-agent-repo"
          placeholder="owner/name"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </Section>
  );
}

/** A field value as the API would store it; as typed when it would be refused. */
function asSaved(value: string): string {
  const parsed = parseAgentRepo(value);
  return parsed.ok ? (parsed.value ?? "") : value.trim();
}
