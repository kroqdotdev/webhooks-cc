"use client";

import { Plus, X } from "lucide-react";
import {
  conditionIssues,
  MAX_CONDITIONS,
  type Condition,
  type ConditionField,
  type ConditionOp,
} from "@webhooks-cc/sdk";
import { cn } from "@/lib/utils";
import {
  FIELD_LABELS,
  OP_LABELS,
  blankCondition,
  fieldsFor,
  keyOf,
  takesValue,
  withField,
  type ConditionUse,
} from "@/lib/condition-labels";

/**
 * Edits a list of conditions as a sentence per row: field, the header or
 * path it reads, how it compares, and with what. Used by response rules
 * (HTTP fields only) and forwarding filters (also the email and the
 * signature check).
 */

const selectClass = "ui-input text-[13px] py-1.5! px-2! min-w-0";
const inputClass = "ui-input text-[13px] font-mono py-1.5! px-2! min-w-0";

function opHint(op: ConditionOp): string | null {
  if (op === "matches")
    return "* matches within one path segment, ** across them, ? one character.";
  if (op === "regex")
    return "RE2 syntax, searched anywhere in the value. Start with (?i) to ignore case.";
  return null;
}

function ConditionRow({
  condition,
  use,
  index,
  idPrefix,
  showRequired,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: Condition;
  use: ConditionUse;
  index: number;
  idPrefix: string;
  showRequired: boolean;
  onChange: (next: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const labels = FIELD_LABELS[condition.field] ?? FIELD_LABELS.path;
  const key = keyOf(condition.field);
  const n = index + 1;
  // "Required" waits for a save attempt; other problems show as soon as they exist.
  const issue = conditionIssues(condition, { use }).find(
    (problem) => showRequired || !problem.includes("is required")
  );
  // A legacy "body contains" condition reads as body text.
  const shownField: ConditionField = condition.field === "body_contains" ? "body" : condition.field;
  const hint = opHint(condition.op);
  return (
    <div role="group" aria-label={`Condition ${n}`} className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label={`Condition ${n}: what to check`}
          value={shownField}
          onChange={(e) => onChange(withField(condition, e.target.value as ConditionField))}
          className={cn(selectClass, "w-36")}
        >
          {fieldsFor(use).map((field) => (
            <option key={field} value={field}>
              {FIELD_LABELS[field].label}
            </option>
          ))}
        </select>
        {key &&
          (labels.keyChoices ? (
            <select
              aria-label={`Condition ${n}: ${labels.keyLabel ?? "which"}`}
              value={condition.name ?? ""}
              onChange={(e) => onChange({ ...condition, name: e.target.value })}
              className={cn(selectClass, "w-32")}
            >
              {labels.keyChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={`Condition ${n}: ${labels.keyLabel}`}
              value={(key === "name" ? condition.name : condition.path) ?? ""}
              onChange={(e) =>
                onChange(
                  key === "name"
                    ? { ...condition, name: e.target.value }
                    : { ...condition, path: e.target.value }
                )
              }
              placeholder={labels.keyPlaceholder}
              spellCheck={false}
              className={cn(inputClass, "w-36")}
            />
          ))}
        <select
          aria-label={`Condition ${n}: how to compare`}
          value={condition.op}
          onChange={(e) => {
            const op = e.target.value as ConditionOp;
            const next: Condition = { ...condition, op };
            if (!takesValue(op)) delete next.value;
            else if (next.value === undefined) next.value = labels.valueChoices?.[0] ?? "";
            onChange(next);
          }}
          className={cn(selectClass, "w-36")}
        >
          {labels.ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
        {takesValue(condition.op) &&
          (labels.valueChoices && (condition.op === "eq" || condition.op === "neq") ? (
            <select
              aria-label={`Condition ${n}: value`}
              value={condition.value ?? ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className={cn(selectClass, "w-32")}
            >
              {labels.valueChoices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={`Condition ${n}: value`}
              value={condition.value ?? ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              placeholder={
                condition.op === "regex"
                  ? "^order\\."
                  : condition.op === "matches"
                    ? "/hooks/*/events"
                    : labels.valuePlaceholder
              }
              inputMode={["gt", "gte", "lt", "lte"].includes(condition.op) ? "decimal" : undefined}
              spellCheck={false}
              className={cn(inputClass, "flex-1 min-w-48")}
            />
          ))}
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove condition ${n}`}
            className="inline-flex items-center justify-center h-7 w-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {issue ? (
        <p id={`${idPrefix}-condition-${index}-issue`} className="text-xs text-destructive">
          {issue.charAt(0).toUpperCase() + issue.slice(1)}.
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function ConditionList({
  conditions,
  logic,
  use,
  idPrefix,
  showRequired = false,
  onChange,
  emptyLabel,
}: {
  conditions: Condition[];
  logic: "and" | "or";
  use: ConditionUse;
  idPrefix: string;
  /** Point out empty required inputs (after a save attempt). */
  showRequired?: boolean;
  onChange: (next: { conditions: Condition[]; logic: "and" | "or" }) => void;
  /** Shown when there are no conditions (filters may have none). */
  emptyLabel?: string;
}) {
  const set = (next: Condition[], nextLogic: "and" | "or" = logic) =>
    onChange({ conditions: next, logic: nextLogic });

  return (
    <div className="space-y-2">
      {conditions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>When</span>
          <select
            aria-label="How the conditions combine"
            value={logic}
            onChange={(e) => set(conditions, e.target.value as "and" | "or")}
            className={cn(selectClass, "w-auto")}
          >
            <option value="and">all</option>
            <option value="or">any</option>
          </select>
          <span>of these match:</span>
        </div>
      ) : conditions.length === 1 ? (
        <p className="text-sm">When this matches:</p>
      ) : emptyLabel ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : null}
      {conditions.map((condition, index) => (
        <ConditionRow
          // Controlled rows: index keys keep every value in place.
          key={index}
          condition={condition}
          use={use}
          index={index}
          idPrefix={idPrefix}
          showRequired={showRequired}
          onChange={(next) => set(conditions.map((c, i) => (i === index ? next : c)))}
          onRemove={() => set(conditions.filter((_, i) => i !== index))}
          canRemove={use === "filter" || conditions.length > 1}
        />
      ))}
      {conditions.length < MAX_CONDITIONS && (
        <button
          type="button"
          onClick={() =>
            set([
              ...conditions,
              blankCondition(conditions.length === 0 && use === "response" ? "method" : "path"),
            ])
          }
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <Plus className="h-3 w-3" /> Add condition
        </button>
      )}
    </div>
  );
}
