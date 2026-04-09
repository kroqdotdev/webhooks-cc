"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusCodePicker } from "./status-code-picker";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { ResponseRule, ResponseRuleCondition } from "@/lib/dashboard-api";

// ── Constants ────────────────────────────────────────────────────────

const CONDITION_FIELDS = [
  { value: "method", label: "Method" },
  { value: "path", label: "Path" },
  { value: "header", label: "Header" },
  { value: "body_contains", label: "Body Contains" },
  { value: "body_path", label: "Body JSON Path" },
  { value: "query", label: "Query Param" },
] as const;

const OPS_BY_FIELD: Record<string, { value: string; label: string }[]> = {
  method: [{ value: "eq", label: "equals" }],
  path: [
    { value: "eq", label: "equals" },
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
    { value: "matches", label: "matches (glob)" },
  ],
  header: [
    { value: "exists", label: "exists" },
    { value: "eq", label: "equals" },
    { value: "contains", label: "contains" },
  ],
  body_contains: [{ value: "contains", label: "contains" }],
  body_path: [
    { value: "exists", label: "exists" },
    { value: "eq", label: "equals" },
    { value: "contains", label: "contains" },
  ],
  query: [
    { value: "exists", label: "exists" },
    { value: "eq", label: "equals" },
  ],
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function newCondition(): ResponseRuleCondition {
  return { field: "method", op: "eq", value: "POST" };
}

function newRule(): ResponseRule {
  return {
    id: generateId(),
    name: "",
    enabled: true,
    logic: "and",
    conditions: [newCondition()],
    response: { status: 200, body: "", headers: {} },
  };
}

// ── ConditionRow ─────────────────────────────────────────────────────

function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
}: {
  condition: ResponseRuleCondition;
  onChange: (c: ResponseRuleCondition) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const ops = OPS_BY_FIELD[condition.field] || [];
  const needsName = condition.field === "header" || condition.field === "query";
  const needsPath = condition.field === "body_path";
  const needsValue = condition.op !== "exists";
  const isMethodField = condition.field === "method";

  return (
    <div className="flex items-start gap-1.5 flex-wrap">
      {/* Field */}
      <select
        aria-label="Condition field"
        value={condition.field}
        onChange={(e) => {
          const field = e.target.value;
          const fieldOps = OPS_BY_FIELD[field] || [];
          onChange({
            field,
            op: fieldOps[0]?.value || "eq",
            value: field === "method" ? "POST" : "",
            name: undefined,
            path: undefined,
          });
        }}
        className="neo-input text-xs py-1! px-2!"
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Name (for header/query) */}
      {needsName && (
        <input
          value={condition.name || ""}
          onChange={(e) => onChange({ ...condition, name: e.target.value })}
          placeholder={condition.field === "header" ? "header-name" : "param-name"}
          aria-label={condition.field === "header" ? "Header name" : "Query parameter name"}
          className="neo-input text-xs py-1! px-2! w-24"
        />
      )}

      {/* Path (for body_path) */}
      {needsPath && (
        <input
          value={condition.path || ""}
          onChange={(e) => onChange({ ...condition, path: e.target.value })}
          placeholder="data.type"
          aria-label="JSON path"
          className="neo-input text-xs py-1! px-2! w-24"
        />
      )}

      {/* Operator */}
      <select
        aria-label="Condition operator"
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value })}
        className="neo-input text-xs py-1! px-2!"
      >
        {ops.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {/* Value */}
      {needsValue &&
        (isMethodField ? (
          <select
            value={condition.value || "POST"}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            className="neo-input text-xs py-1! px-2!"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={condition.value || ""}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder="value"
            aria-label="Condition value"
            className="neo-input text-xs py-1! px-2! flex-1 min-w-20"
          />
        ))}

      {/* Remove */}
      {canRemove && (
        <button
          onClick={onRemove}
          className="p-1.5 hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0 cursor-pointer"
          title="Remove condition"
          aria-label="Remove condition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ── RuleCard ─────────────────────────────────────────────────────────

function RuleCard({
  rule,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  rule: ResponseRule;
  index: number;
  total: number;
  onChange: (r: ResponseRule) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const updateCondition = (i: number, c: ResponseRuleCondition) => {
    const next = [...rule.conditions];
    next[i] = c;
    onChange({ ...rule, conditions: next });
  };

  const removeCondition = (i: number) => {
    onChange({ ...rule, conditions: rule.conditions.filter((_, idx) => idx !== i) });
  };

  const addCondition = () => {
    onChange({ ...rule, conditions: [...rule.conditions, newCondition()] });
  };

  const summary = rule.name
    || `Rule ${index + 1}: ${rule.conditions.length} condition${rule.conditions.length !== 1 ? "s" : ""}`;

  return (
    <div
      className={`border-2 border-foreground ${!rule.enabled ? "opacity-50" : ""}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

        {/* Move buttons */}
        <div className="flex flex-col -my-1">
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            className="p-0.5 hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
            title="Move up"
            aria-label="Move rule up"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="p-0.5 hover:bg-muted disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
            title="Move down"
            aria-label="Move rule down"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>

        {/* Name / Summary */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex-1 text-left text-xs font-bold uppercase tracking-wide truncate cursor-pointer"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${summary}`}
        >
          {summary}
        </button>

        {/* Enable/Disable */}
        <label className="flex items-center gap-1 shrink-0 cursor-pointer" title="Enable/disable rule">
          <input
            type="checkbox"
            checked={rule.enabled !== false}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
            className="accent-foreground"
          />
          <span className="text-xs text-muted-foreground sr-only">Enabled</span>
        </label>

        {/* Delete */}
        <button
          onClick={onRemove}
          className="p-1.5 hover:bg-destructive/10 hover:text-destructive transition-colors shrink-0 cursor-pointer"
          title="Delete rule"
          aria-label="Delete rule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="p-3 space-y-3">
          {/* Name */}
          <input
            value={rule.name || ""}
            onChange={(e) => onChange({ ...rule, name: e.target.value })}
            placeholder="Rule name (optional)"
            className="neo-input w-full text-xs py-1! px-2!"
          />

          {/* Logic toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Match</span>
            <select
              value={rule.logic || "and"}
              onChange={(e) => onChange({ ...rule, logic: e.target.value })}
              className="neo-input text-xs py-0.5! px-2!"
            >
              <option value="and">ALL conditions (AND)</option>
              <option value="or">ANY condition (OR)</option>
            </select>
          </div>

          {/* Conditions */}
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide">Conditions</p>
            {rule.conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                condition={cond}
                onChange={(c) => updateCondition(i, c)}
                onRemove={() => removeCondition(i)}
                canRemove={rule.conditions.length > 1}
              />
            ))}
            {rule.conditions.length < 10 && (
              <button
                onClick={addCondition}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors cursor-pointer"
              >
                <Plus className="h-3 w-3" /> Add condition
              </button>
            )}
          </div>

          {/* Response */}
          <div className="space-y-2 border-t-2 border-foreground pt-3">
            <p className="text-xs font-bold uppercase tracking-wide">Response</p>
            <div className="flex items-center gap-2">
              <StatusCodePicker
                id={`rule-${rule.id}-status`}
                value={rule.response.status.toString()}
                onChange={(code) =>
                  onChange({
                    ...rule,
                    response: { ...rule.response, status: parseInt(code, 10) },
                  })
                }
              />
            </div>
            <Textarea
              value={rule.response.body}
              onChange={(e) =>
                onChange({
                  ...rule,
                  response: { ...rule.response, body: e.target.value },
                })
              }
              placeholder="Response body"
              rows={2}
              className="border-2 border-foreground rounded-none text-xs font-mono"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── ResponseRulesEditor ──────────────────────────────────────────────

export interface ResponseRulesEditorProps {
  rules: ResponseRule[];
  onChange: (rules: ResponseRule[]) => void;
}

export function ResponseRulesEditor({ rules, onChange }: ResponseRulesEditorProps) {
  const updateRule = (index: number, rule: ResponseRule) => {
    const next = [...rules];
    next[index] = rule;
    onChange(next);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const next = [...rules];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onChange(next);
  };

  const moveDown = (index: number) => {
    if (index >= rules.length - 1) return;
    const next = [...rules];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onChange(next);
  };

  const addRule = () => {
    onChange([...rules, newRule()]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-bold uppercase tracking-wide text-xs">Response Rules</p>
          <p className="text-xs text-muted-foreground">
            First matching rule wins. Falls back to the default mock response below.
          </p>
        </div>
      </div>

      {rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((rule, index) => (
            <RuleCard
              key={rule.id || index}
              rule={rule}
              index={index}
              total={rules.length}
              onChange={(r) => updateRule(index, r)}
              onRemove={() => removeRule(index)}
              onMoveUp={() => moveUp(index)}
              onMoveDown={() => moveDown(index)}
            />
          ))}
        </div>
      )}

      {rules.length < 50 && (
        <button
          onClick={addRule}
          className="neo-btn-outline py-1.5! px-3! text-xs w-full flex items-center justify-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add Rule
        </button>
      )}
    </div>
  );
}
