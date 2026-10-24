"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { conditionIssues, type Condition } from "@webhooks-cc/sdk";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { describeConditions } from "@/lib/condition-labels";
import { trackEndpointSaved } from "@/lib/analytics";
import {
  fetchDashboardRequests,
  previewResponses,
  type DashboardEndpoint,
  type ResponsePreviewResult,
  type ResponseRule,
} from "@/lib/dashboard-api";
import { ConditionList } from "./condition-list";
import {
  ResponseEditor,
  draftIssues,
  fromDraft,
  isPlainOk,
  toDraft,
  type ResponseDraft,
} from "./response-editor";
import { SaveFooter, Section, Switch, useSave } from "./settings-primitives";
import { statusLine } from "./status-code-picker";

/**
 * What senders get back. The rules and the default response are one list
 * in the order the receiver checks them: numbered rules from the top, the
 * first that matches answers, and "Otherwise" at the bottom answers the
 * rest. Below it, a preview runs the unsaved list against a captured
 * request, with the same rule language and placeholders as the receiver,
 * and marks the row that answers.
 */

const MAX_RULES = 50;

interface RuleDraft {
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  logic: "and" | "or";
  conditions: Condition[];
  response: ResponseDraft;
}

const randomId = () => Math.random().toString(36).slice(2, 10);

/** A saved rule as a draft; a legacy body_contains reads as body text. */
function toRuleDraft(rule: ResponseRule): RuleDraft {
  return {
    key: randomId(),
    id: rule.id || randomId(),
    name: rule.name ?? "",
    enabled: rule.enabled !== false,
    logic: rule.logic === "or" ? "or" : "and",
    conditions: rule.conditions.map((condition) =>
      condition.field === "body_contains" ? { ...condition, field: "body" } : condition
    ),
    response: toDraft(rule.response),
  };
}

function fromRuleDraft(rule: RuleDraft): ResponseRule {
  return {
    id: rule.id,
    ...(rule.name.trim() ? { name: rule.name.trim() } : {}),
    enabled: rule.enabled,
    logic: rule.logic,
    conditions: rule.conditions,
    response: fromDraft(rule.response),
  };
}

function settingsOf(fallback: ResponseDraft, rules: RuleDraft[]) {
  return {
    mockResponse: isPlainOk(fallback) ? null : fromDraft(fallback),
    responseRules: rules.length > 0 ? rules.map(fromRuleDraft) : null,
  };
}

/** The status chip's tone: success, client error, server error, or neutral. */
function statusTone(status: number): string {
  if (status >= 200 && status < 300) return "bg-primary text-primary-foreground";
  if (status >= 400 && status < 500) return "bg-secondary text-secondary-foreground";
  if (status >= 500) return "bg-destructive text-destructive-foreground";
  return "bg-muted text-foreground";
}

function StatusChip({ status }: { status: number }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center min-w-11 px-1.5 py-0.5 text-xs font-mono font-bold border-strong border-line rounded-sm",
        statusTone(status)
      )}
    >
      {status}
    </span>
  );
}

function RowHeader({
  marker,
  summary,
  status,
  open,
  answers,
  onToggle,
  controlsId,
  trailing,
  dim,
}: {
  marker: string;
  summary: React.ReactNode;
  status: number;
  open: boolean;
  answers: boolean;
  onToggle: () => void;
  controlsId: string;
  trailing?: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 pr-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={controlsId}
        className={cn(
          "flex-1 min-w-0 flex items-center gap-3 text-left px-3 py-2.5 cursor-pointer",
          dim && "opacity-55"
        )}
      >
        <span className="w-16 shrink-0 text-xs font-bold caps text-muted-foreground">{marker}</span>
        <span className="flex-1 min-w-0 truncate text-sm">{summary}</span>
        {answers && (
          <span className="hidden sm:inline shrink-0 text-xs font-semibold text-foreground">
            Answers the preview
          </span>
        )}
        <StatusChip status={status} />
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
      {trailing}
    </div>
  );
}

function PreviewPanel({
  slug,
  settings,
  blocked,
  ruleCount,
  onResult,
}: {
  slug: string;
  ruleCount: number;
  settings: ReturnType<typeof settingsOf>;
  /** Why the preview cannot run yet (invalid fields), or null. */
  blocked: string | null;
  onResult: (result: ResponsePreviewResult | null) => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [requests, setRequests] = useState<
    { id: string; method: string; path: string; receivedAt: number }[] | null
  >(null);
  const [requestId, setRequestId] = useState<string>("");
  const [result, setResult] = useState<ResponsePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetchDashboardRequests(accessToken, slug, 20, "http")
      .then((rows) => {
        if (!cancelled) {
          setRequests(
            rows.map((row) => ({
              id: row._id,
              method: row.method,
              path: row.path,
              receivedAt: row.receivedAt,
            }))
          );
        }
      })
      .catch(() => !cancelled && setRequests([]));
    return () => {
      cancelled = true;
    };
  }, [accessToken, slug]);

  const settingsJson = JSON.stringify(settings);
  useEffect(() => {
    if (!accessToken || blocked) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      previewResponses(
        accessToken,
        slug,
        { requestId: requestId || null, ...JSON.parse(settingsJson) },
        controller.signal
      )
        .then((next) => {
          setResult(next);
          setError(null);
          onResult(next);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "The preview could not be loaded.");
          onResult(null);
        })
        .finally(() => !controller.signal.aborted && setLoading(false));
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, slug, requestId, settingsJson, blocked, onResult]);

  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  let verdict: React.ReactNode = null;
  if (result) {
    if (result.rule) {
      verdict = (
        <>
          Rule {result.rule.index + 1}
          {result.rule.name ? `, ${result.rule.name},` : ""} answers
        </>
      );
    } else if (ruleCount === 0) {
      verdict = "Every request gets this";
    } else {
      verdict = "No rule matches, so Otherwise answers";
    }
  }

  return (
    <div className="pt-4 border-t border-line/20 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`responses-preview-${slug}`} className="text-sm font-semibold">
          Preview with
        </label>
        <select
          id={`responses-preview-${slug}`}
          value={requestId}
          onChange={(e) => setRequestId(e.target.value)}
          className="ui-input text-[13px] font-mono py-1.5! px-2! min-w-0 flex-1 max-w-[28rem]"
        >
          <option value="">
            {requests && requests.length === 0
              ? "A sample request (none captured yet)"
              : "The newest request"}
          </option>
          {(requests ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.method} {row.path} at {time(row.receivedAt)}
            </option>
          ))}
        </select>
      </div>
      <div role="status" aria-live="polite" aria-busy={loading} className="space-y-2 text-sm">
        {blocked ? (
          <p className="text-muted-foreground">{blocked}</p>
        ) : error ? (
          <p className="text-destructive">{error}</p>
        ) : result ? (
          <>
            <p>
              <span className="font-semibold">{verdict}</span>
              {result.response && result.response.delay > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  after <span className="font-mono">{result.response.delay} ms</span>
                </span>
              )}
              .
            </p>
            <pre className="ui-code text-xs! leading-[18px] p-3! whitespace-pre-wrap break-all max-h-72 overflow-auto">
              <span className="font-bold">{statusLine(result.response?.status ?? 200)}</span>
              {Object.entries(result.response?.headers ?? {}).map(([name, value]) => (
                <span key={name}>
                  {"\n"}
                  <span className="syntax-property">{name}</span>
                  <span className="text-muted-foreground">: {value}</span>
                </span>
              ))}
              {"\n\n"}
              {result.response ? result.response.body || "(empty body)" : "OK"}
            </pre>
            {result.unknownPlaceholders.length > 0 && (
              <p className="text-xs text-muted-foreground max-w-[62ch]">
                {result.unknownPlaceholders.join(", ")}{" "}
                {result.unknownPlaceholders.length === 1 ? "is" : "are"} not a field the request
                has, so {result.unknownPlaceholders.length === 1 ? "it is" : "they are"} sent as
                written. Use Insert field to pick one.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">Loading the preview...</p>
        )}
      </div>
    </div>
  );
}

export function ResponsesSection({ endpoint }: { endpoint: DashboardEndpoint }) {
  // Keyed on values, not object identity: every endpoints refetch (another
  // section saving) hands back new objects, which must not discard edits here.
  const savedJson = JSON.stringify({
    mock: endpoint.mockResponse ?? null,
    rules: endpoint.responseRules ?? [],
  });
  const initial = useMemo(() => {
    const saved = JSON.parse(savedJson) as {
      mock: DashboardEndpoint["mockResponse"] | null;
      rules: ResponseRule[];
    };
    const fallback = toDraft(saved.mock ?? null);
    const rules = saved.rules.map(toRuleDraft);
    return { fallback, rules, settings: JSON.stringify(settingsOf(fallback, rules)) };
  }, [savedJson]);

  const [fallback, setFallback] = useState<ResponseDraft>(initial.fallback);
  const [rules, setRules] = useState<RuleDraft[]>(initial.rules);
  const [open, setOpen] = useState<Set<string>>(() =>
    initial.rules.length === 0 ? new Set(["fallback"]) : new Set()
  );
  const [submitted, setSubmitted] = useState(false);
  const [answering, setAnswering] = useState<number | "fallback" | null>(null);
  const { save, saving, error, saved, setError, setSaved } = useSave(endpoint.slug);
  const listRef = useRef<HTMLOListElement>(null);

  const reset = useCallback(() => {
    setFallback(initial.fallback);
    setRules(initial.rules);
    setSubmitted(false);
  }, [initial]);
  useEffect(reset, [reset]);

  const settings = settingsOf(fallback, rules);
  const dirty = JSON.stringify(settings) !== initial.settings;

  // Problems, per row, that keep the list from saving (and the preview from running).
  const ruleProblems = rules.map((rule) => [
    ...(rule.conditions.length === 0 ? ["Add a condition, or delete the rule."] : []),
    ...rule.conditions.flatMap((condition) => conditionIssues(condition, { use: "response" })),
    ...draftIssues(rule.response),
  ]);
  const fallbackProblems = draftIssues(fallback);
  const problemCount =
    ruleProblems.reduce((count, list) => count + (list.length > 0 ? 1 : 0), 0) +
    (fallbackProblems.length > 0 ? 1 : 0);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const updateRule = (key: string, patch: Partial<RuleDraft>) =>
    setRules((prev) => prev.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));

  const move = (index: number, by: -1 | 1) =>
    setRules((prev) => {
      const next = [...prev];
      const target = index + by;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const addRule = () => {
    const rule: RuleDraft = {
      key: randomId(),
      id: randomId(),
      name: "",
      enabled: true,
      logic: "and",
      conditions: [{ field: "method", op: "eq", value: "POST" }],
      response: toDraft({ status: 200, body: "", headers: {} }),
    };
    setRules((prev) => [...prev, rule]);
    setOpen((prev) => new Set(prev).add(rule.key));
  };

  const onResult = useCallback((result: ResponsePreviewResult | null) => {
    if (!result || result.email) setAnswering(null);
    else setAnswering(result.rule ? result.rule.index : "fallback");
  }, []);

  const onSave = () => {
    setSubmitted(true);
    void save(settings, () => {
      if (problemCount > 0) {
        throw new Error(
          problemCount === 1
            ? "Fix the response marked above."
            : `Fix the ${problemCount} responses marked above.`
        );
      }
    }).then((ok) => {
      if (!ok) return;
      setSubmitted(false);
      const before = JSON.parse(savedJson) as { mock: { status?: number; body?: string } | null };
      trackEndpointSaved(
        {
          name: endpoint.name ?? "",
          mockStatus: String(before.mock?.status ?? 200),
          mockBody: before.mock?.body ?? "",
        },
        { name: endpoint.name ?? "", mockStatus: fallback.status, mockBody: fallback.body }
      );
    });
  };

  const hint = (() => {
    const before = JSON.parse(initial.settings) as ReturnType<typeof settingsOf>;
    const rulesChanged =
      JSON.stringify(before.responseRules) !== JSON.stringify(settings.responseRules);
    const fallbackChanged =
      JSON.stringify(before.mockResponse) !== JSON.stringify(settings.mockResponse);
    if (rulesChanged && fallbackChanged) return "Rules and the default response changed.";
    if (rulesChanged) return "Rules changed.";
    return "Default response changed.";
  })();

  const previewBlocked =
    problemCount > 0
      ? "The preview runs once the fields marked above are filled in correctly."
      : null;

  return (
    <Section
      id="responses"
      title="Responses"
      description="What senders get back. Rules are checked from the top and the first that matches answers; everything else gets Otherwise. Emails always get a standard mail-server reply."
      footer={
        <SaveFooter
          dirty={dirty}
          saving={saving}
          error={error}
          saved={saved}
          hint={hint}
          onReset={() => {
            reset();
            setError(null);
            setSaved(false);
          }}
          onSave={onSave}
        />
      }
    >
      <ol
        ref={listRef}
        aria-label="Responses in the order they are checked"
        className="border-strong border-line rounded-md divide-y divide-line/30 overflow-hidden"
      >
        {rules.map((rule, index) => {
          const isOpen = open.has(rule.key);
          const problems = ruleProblems[index];
          const showProblems = submitted && problems.length > 0;
          const status = fromDraft(rule.response).status;
          const panelId = `responses-rule-${rule.key}`;
          const summary = rule.name.trim() || describeConditions(rule.conditions, rule.logic);
          return (
            <li
              key={rule.key}
              className={cn(
                "relative bg-card",
                answering === index &&
                  "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary",
                showProblems &&
                  "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-destructive"
              )}
            >
              <RowHeader
                marker={`Rule ${index + 1}`}
                summary={
                  <>
                    {rule.name.trim() ? (
                      <span className="font-semibold">{summary}</span>
                    ) : (
                      <>
                        <span className="text-muted-foreground">When </span>
                        {summary}
                      </>
                    )}
                    {!rule.enabled && <span className="text-muted-foreground"> (off)</span>}
                  </>
                }
                status={status}
                open={isOpen}
                answers={answering === index}
                onToggle={() => toggle(rule.key)}
                controlsId={panelId}
                dim={!rule.enabled}
                trailing={
                  <Switch
                    id={`${panelId}-enabled`}
                    checked={rule.enabled}
                    onChange={(enabled) => updateRule(rule.key, { enabled })}
                    label={`Rule ${index + 1} on`}
                  />
                }
              />
              {isOpen && (
                <div id={panelId} className="px-3 pb-4 pt-1 space-y-4 border-t border-line/20">
                  <div className="pt-3 space-y-1.5">
                    <label htmlFor={`${panelId}-name`} className="block text-xs font-bold caps">
                      Name
                    </label>
                    <input
                      id={`${panelId}-name`}
                      value={rule.name}
                      onChange={(e) => updateRule(rule.key, { name: e.target.value })}
                      placeholder="Optional, for example Payment failed"
                      maxLength={200}
                      className="ui-input w-full text-sm py-1.5!"
                    />
                  </div>
                  <ConditionList
                    conditions={rule.conditions}
                    logic={rule.logic}
                    use="response"
                    idPrefix={panelId}
                    showRequired={submitted}
                    onChange={({ conditions, logic }) =>
                      updateRule(rule.key, { conditions, logic })
                    }
                  />
                  <div className="pt-3 border-t border-line/20 space-y-2">
                    <p className="text-sm font-semibold">Answer with</p>
                    <ResponseEditor
                      draft={rule.response}
                      onChange={(response) => updateRule(rule.key, { response })}
                      idPrefix={panelId}
                    />
                  </div>
                  {showProblems && <p className="text-xs text-destructive">{problems[0]}</p>}
                  <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-line/20">
                    {rules.length > 1 && (
                      <>
                        <button
                          type="button"
                          onClick={() => move(index, -1)}
                          disabled={index === 0}
                          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ArrowUp className="h-3 w-3" /> Check earlier
                        </button>
                        <button
                          type="button"
                          onClick={() => move(index, 1)}
                          disabled={index === rules.length - 1}
                          className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <ArrowDown className="h-3 w-3" /> Check later
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setRules((prev) => prev.filter((r) => r.key !== rule.key))}
                      className="ui-btn-outline py-1! px-2.5! text-xs inline-flex items-center gap-1.5 ml-auto text-destructive"
                    >
                      <Trash2 className="h-3 w-3" /> Delete rule
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        <li
          className={cn(
            "relative bg-muted/30",
            answering === "fallback" &&
              "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary",
            submitted &&
              fallbackProblems.length > 0 &&
              "before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-destructive"
          )}
        >
          <RowHeader
            marker={rules.length > 0 ? "Otherwise" : "Always"}
            summary={
              isPlainOk(fallback) ? (
                <span className="text-muted-foreground">200 OK with an empty body</span>
              ) : (
                <span className="font-mono text-[13px] text-muted-foreground">
                  {fallback.body.trim().slice(0, 120) || "(empty body)"}
                </span>
              )
            }
            status={fromDraft(fallback).status}
            open={open.has("fallback")}
            answers={answering === "fallback"}
            onToggle={() => toggle("fallback")}
            controlsId="responses-fallback"
          />
          {open.has("fallback") && (
            <div id="responses-fallback" className="px-3 pb-4 pt-3 border-t border-line/20">
              <ResponseEditor
                draft={fallback}
                onChange={setFallback}
                idPrefix="responses-fallback"
              />
            </div>
          )}
        </li>
      </ol>

      {rules.length < MAX_RULES && (
        <button
          type="button"
          onClick={addRule}
          className="ui-btn-outline py-1.5! px-3! text-xs inline-flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add rule
        </button>
      )}

      <PreviewPanel
        slug={endpoint.slug}
        settings={settings}
        blocked={previewBlocked}
        ruleCount={rules.length}
        onResult={onResult}
      />
    </Section>
  );
}
