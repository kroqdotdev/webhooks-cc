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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const triggerClass =
  "h-8 min-w-0 gap-1.5 text-[13px] rounded-md border border-border bg-background px-2 py-0 text-left cursor-pointer focus:ring-offset-0";
const inputClass = "ui-input h-8 text-[13px] font-mono py-0! px-2! min-w-0";

/**
 * The rows' picker: the shared select at the rows' size. An unset value shows
 * the placeholder (every Select item needs a value), and a value the
 * choices do not hold, such as an older condition's, is still listed so the
 * row shows what is saved.
 */
function ChoiceSelect({
  label,
  value,
  choices,
  onChange,
  className,
}: {
  label: string;
  value: string;
  choices: { value: string; label: string }[];
  onChange: (next: string) => void;
  className?: string;
}) {
  const listed =
    value && !choices.some((choice) => choice.value === value)
      ? [...choices, { value, label: value }]
      : choices;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn(triggerClass, className)}>
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent className="border border-border shadow-float max-h-80">
        {listed.map((choice) => (
          <SelectItem key={choice.value} value={choice.value} className="text-[13px]">
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
  emailFieldNames,
}: {
  condition: Condition;
  use: ConditionUse;
  index: number;
  idPrefix: string;
  showRequired: boolean;
  emailFieldNames: string[];
  onChange: (next: Condition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const labels = FIELD_LABELS[condition.field] ?? FIELD_LABELS.path;
  const key = keyOf(condition.field);
  // "Email field" picks one of the endpoint's own fields when it has any.
  const keyChoices =
    condition.field === "email_field" && emailFieldNames.length > 0
      ? [
          ...emailFieldNames.map((name) => ({ value: name, label: name })),
          ...(condition.name && !emailFieldNames.includes(condition.name)
            ? [{ value: condition.name, label: condition.name }]
            : []),
        ]
      : labels.keyChoices;
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
        <ChoiceSelect
          label={`Condition ${n}: what to check`}
          value={shownField}
          choices={fieldsFor(use).map((field) => ({
            value: field,
            label: FIELD_LABELS[field].label,
          }))}
          onChange={(value) => {
            const next = withField(condition, value as ConditionField);
            onChange(
              next.field === "email_field" && !next.name && emailFieldNames[0]
                ? { ...next, name: emailFieldNames[0] }
                : next
            );
          }}
          className="w-36"
        />
        {key &&
          (keyChoices ? (
            <ChoiceSelect
              label={`Condition ${n}: ${labels.keyLabel ?? "which"}`}
              value={condition.name ?? ""}
              choices={keyChoices}
              onChange={(name) => onChange({ ...condition, name })}
              className="w-32"
            />
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
        <ChoiceSelect
          label={`Condition ${n}: how to compare`}
          value={condition.op}
          choices={labels.ops.map((op) => ({ value: op, label: OP_LABELS[op] }))}
          onChange={(value) => {
            const op = value as ConditionOp;
            const next: Condition = { ...condition, op };
            if (!takesValue(op)) delete next.value;
            else if (next.value === undefined) next.value = labels.valueChoices?.[0] ?? "";
            onChange(next);
          }}
          className="w-36"
        />
        {takesValue(condition.op) &&
          (labels.valueChoices && (condition.op === "eq" || condition.op === "neq") ? (
            <ChoiceSelect
              label={`Condition ${n}: value`}
              value={condition.value ?? ""}
              choices={labels.valueChoices.map((choice) => ({ value: choice, label: choice }))}
              onChange={(value) => onChange({ ...condition, value })}
              className="w-32"
            />
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
        <p id={`${idPrefix}-condition-${index}-issue`} className="text-xs text-destructive-ink">
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
  emailFieldNames = [],
  lead = true,
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
  /** The endpoint's named email fields: what "Email field" offers. */
  emailFieldNames?: string[];
  /** Lead a single condition with "When this matches:"; off where a heading already says it. */
  lead?: boolean;
}) {
  const set = (next: Condition[], nextLogic: "and" | "or" = logic) =>
    onChange({ conditions: next, logic: nextLogic });

  return (
    <div className="space-y-2">
      {conditions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>When</span>
          <ChoiceSelect
            label="How the conditions combine"
            value={logic}
            choices={[
              { value: "and", label: "all" },
              { value: "or", label: "any" },
            ]}
            onChange={(value) => set(conditions, value as "and" | "or")}
            className="w-auto"
          />
          <span>of these match:</span>
        </div>
      ) : conditions.length === 1 ? (
        lead && <p className="text-sm">When this matches:</p>
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
          emailFieldNames={emailFieldNames}
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
