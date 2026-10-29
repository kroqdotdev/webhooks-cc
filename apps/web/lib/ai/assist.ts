import type { Condition } from "@webhooks-cc/sdk";
import { htmlToText, type EmailField } from "@webhooks-cc/sdk/email";
import { emailFieldsProblems, emailFieldValues } from "@/lib/email-fields";
import { reportError } from "@/lib/observability";
import { ruleSubjectFor } from "@/lib/request-context";
import { conditionsHold } from "@/lib/rules";
import type { RequestRecord } from "@/lib/supabase/requests";
import { AssistModelError, proposePatterns, type Proposal } from "./model";

/**
 * AI setup and repair: from emails a person picked, propose a field, a whole
 * layout, or a repair of a field that stopped matching. Only what compiles
 * with RE2 and finds a value in every sample is returned; nothing is saved
 * (the person adds what they want through the usual editors). A first
 * proposal that fails is sent back once with what went wrong.
 */

export type AssistAsk =
  | { kind: "field"; name: string; description: string }
  | { kind: "layout"; description: string }
  | { kind: "repair"; field: EmailField };

export interface ProposedField {
  field: EmailField;
  /** The value it found in each sample, in the order the samples were given. */
  values: string[];
}

export interface AssistResult {
  fields: ProposedField[];
  /** For a layout: a condition every sample meets, to pick this layout. */
  match: Condition | null;
  layoutName: string | null;
  /** Proposals dropped because they did not compile or missed a sample. */
  dropped: number;
}

/** Samples at most, and how much of each part the model reads at full size. */
export const MAX_SAMPLES = 5;
const MAX_PART_CHARS = 8_000;
const MAX_LINE_CHARS = 1_000;
const MAX_HEADERS = 40;
const MAX_HEADER_NAME_CHARS = 100;
const MAX_HEADER_VALUE_CHARS = 200;
/** The samples together, as the JSON the prompt carries: what one ask may send at most. */
const MAX_PROMPT_CHARS = 60_000;
/**
 * The whole ask, both model calls included: under the 100 seconds a proxy in
 * front of the app waits for an answer, so a person never pays for an
 * answer they cannot see. The busy window in take_ai_assist() is longer.
 */
const ASSIST_DEADLINE_MS = 80_000;
/** The second call (with feedback) only starts with at least this much time left. */
const RETRY_MIN_MS = 25_000;
/** Checking proposals runs in the web process: it stops after this long. */
const CHECK_BUDGET_MS = 1_500;
/** A layout's match text: shorter would pick up mail it was never meant for. */
const MIN_MATCH_CHARS = 3;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function cut(text: string | null | undefined, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  // Never between the two halves of a surrogate pair (an emoji, say): a
  // lone half is not valid text, and the API refuses it.
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)} [cut]`;
}

function addressText(
  list: { name?: string | null; address?: string | null }[] | undefined
): string {
  return (list ?? [])
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? "")))
    .join(", ");
}

/** An email's parts the model reads, whole; cut to size by sampleAt(). Never attachments. */
interface SampleSource {
  subject: string;
  from: string;
  to: string;
  text: string | null;
  html: string | null;
  headers: [string, string][];
}

function sourceFor(request: RequestRecord): SampleSource {
  const email = request.email!;
  const html = email.html ? htmlToText(email.html) : null;
  return {
    subject: email.subject ?? "",
    from: addressText(email.from),
    to: addressText([...(email.to ?? []), ...(email.cc ?? [])]),
    text: email.text ?? null,
    html,
    headers: Object.entries(request.headers ?? {}).map(([name, value]) => [name, String(value)]),
  };
}

/** A sample at a scale: 1 is full size, smaller cuts every part shorter. */
function sampleAt(source: SampleSource, scale: number): Record<string, unknown> {
  const part = Math.max(500, Math.floor(MAX_PART_CHARS * scale));
  const line = Math.max(200, Math.floor(MAX_LINE_CHARS * scale));
  const headerValue = Math.max(80, Math.floor(MAX_HEADER_VALUE_CHARS * scale));
  const headerCount = Math.max(15, Math.floor(MAX_HEADERS * scale));
  return {
    subject: cut(source.subject, line),
    from: cut(source.from, line),
    to: cut(source.to, line),
    text: cut(source.text ?? source.html, part),
    ...(source.html && source.html !== source.text ? { html: cut(source.html, part) } : {}),
    headers: Object.fromEntries(
      source.headers
        .slice(0, headerCount)
        .map(([name, value]) => [cut(name, MAX_HEADER_NAME_CHARS), cut(value, headerValue)])
    ),
  };
}

/** The ask cannot be sent as it is; nothing was taken. */
export class AssistInputError extends Error {}

/** The samples within the prompt's budget: every part is cut shorter until they fit. */
function samplesWithinBudget(requests: RequestRecord[]): Record<string, unknown>[] {
  const sources = requests.map(sourceFor);
  for (const scale of [1, 0.5, 0.25, 0.125, 0.0625]) {
    const samples = sources.map((source) => sampleAt(source, scale));
    if (JSON.stringify(samples, null, 1).length <= MAX_PROMPT_CHARS) return samples;
  }
  throw new AssistInputError("These emails are too large to send together. Pick fewer of them.");
}

function instructionFor(ask: AssistAsk, count: number): string {
  switch (ask.kind) {
    case "field":
      return `Propose one field named "${ask.name}" that finds this in every one of the ${count} samples: ${ask.description}`;
    case "layout":
      return `Propose a layout for emails like these ${count} samples: a short layoutName, a match condition (text that every sample's subject, or every sample's sender, contains, and that other kinds of email would not), and the fields worth reading from them${ask.description ? `, in particular: ${ask.description}` : ""}. At most 10 fields.`;
    case "repair":
      return `The field "${ask.field.name}" used to read "${ask.field.from}"${ask.field.from === "header" ? ` header "${ask.field.header}"` : ""} with the pattern ${JSON.stringify(ask.field.pattern)}, and no longer finds a value in these ${count} recent emails. Propose a corrected field with the same name that finds the value in every sample (keep the same meaning).`;
  }
}

/** The proposal's fields, each checked and run on every sample. */
function check(
  proposal: Proposal,
  ask: AssistAsk,
  requests: RequestRecord[]
): { passed: ProposedField[]; failures: string[] } {
  const failures: string[] = [];
  const seen = new Set<string>();
  // A field asked for by name keeps that name, whatever the model called
  // it; its proposals are alternatives, tried in order until one passes.
  // A layout's are different fields, all kept that pass.
  const single = ask.kind !== "layout";
  // First what needs no email: names, sources, RE2, size.
  const candidates: EmailField[] = [];
  for (const raw of proposal.fields.slice(0, 10)) {
    const name =
      ask.kind === "field" ? ask.name : ask.kind === "repair" ? ask.field.name : raw.name.trim();
    if (!FIELD_NAME.test(name) || (!single && seen.has(name))) {
      failures.push(`"${raw.name}" is not a usable field name.`);
      continue;
    }
    const field: EmailField = {
      name,
      from: raw.from,
      ...(raw.from === "header" && raw.header ? { header: raw.header.trim().toLowerCase() } : {}),
      pattern: raw.pattern,
    };
    const problems = emailFieldsProblems([field]);
    if (problems.length > 0) {
      failures.push(`${name}: ${problems[0]}`);
      continue;
    }
    seen.add(name);
    candidates.push(field);
  }
  // A layout's fields together must stay small enough to run on every
  // email, checked before any of them runs.
  while (!single && candidates.length > 0 && emailFieldsProblems(candidates).length > 0) {
    failures.push(`${candidates.pop()!.name}: the patterns together are too large.`);
  }

  // Then each on the samples, stopping at the first one it misses, within a
  // time budget (this runs in the web process).
  const passed: ProposedField[] = [];
  const started = Date.now();
  for (const field of candidates) {
    if (Date.now() - started > CHECK_BUDGET_MS) {
      failures.push(`${field.name}: not checked (the patterns took too long to run).`);
      continue;
    }
    const values: string[] = [];
    let missed = 0;
    for (const [i, request] of requests.entries()) {
      const value = emailFieldValues(request, [field], { cache: false })?.[field.name] ?? null;
      if (value === null) {
        missed = i + 1;
        break;
      }
      values.push(value);
    }
    if (missed > 0) {
      failures.push(
        `${field.name} (${JSON.stringify(field.pattern)} on ${field.from}) found nothing in sample ${missed}.`
      );
      continue;
    }
    passed.push({ field, values });
    if (single) break;
  }
  return { passed, failures };
}

function matchFor(proposal: Proposal, requests: RequestRecord[]): Condition | null {
  const contains = proposal.match?.contains.trim();
  if (!proposal.match || !contains || contains.length < MIN_MATCH_CHARS || contains.length > 200) {
    return null;
  }
  const condition: Condition = {
    field: "email",
    name: proposal.match.part,
    op: "contains",
    value: contains,
  };
  const holds = requests.every((request) =>
    conditionsHold({ conditions: [condition] }, ruleSubjectFor(request))
  );
  return holds ? condition : null;
}

export interface PreparedAssist {
  instruction: string;
  samples: Record<string, unknown>[];
}

/**
 * What the model will read, built before an assist is taken: throws
 * AssistInputError when the emails cannot be sent as they are.
 */
export function prepareAssist(ask: AssistAsk, requests: RequestRecord[]): PreparedAssist {
  const samples = samplesWithinBudget(requests);
  return { instruction: instructionFor(ask, samples.length), samples };
}

/**
 * Proposes what was asked from the samples (emails of the endpoint, already
 * loaded and checked by the caller). Throws AssistModelError when the model
 * cannot be asked or its answer cannot be used.
 */
export async function runAssist(
  ask: AssistAsk,
  requests: RequestRecord[],
  { instruction, samples }: PreparedAssist
): Promise<AssistResult> {
  const signal = AbortSignal.timeout(ASSIST_DEADLINE_MS);
  const deadline = Date.now() + ASSIST_DEADLINE_MS;
  let proposal = await proposePatterns({ instruction, samples }, { signal, maxRetries: 1 });

  // From here the model has answered: any failure keeps the assist.
  try {
    let { passed, failures } = check(proposal, ask, requests);
    if (passed.length === 0 && failures.length > 0 && deadline - Date.now() >= RETRY_MIN_MS) {
      // Once more, with what went wrong, and no retries of its own.
      proposal = await proposePatterns(
        {
          instruction,
          samples,
          feedback: `An earlier proposal failed when tested on the samples:\n- ${failures.slice(0, 10).join("\n- ")}\nPropose patterns that find the value in every sample.`,
        },
        { signal, maxRetries: 0 }
      );
      const retry = check(proposal, ask, requests);
      passed = retry.passed;
      failures = [...failures, ...retry.failures];
    }
    return {
      fields: passed,
      match: ask.kind === "layout" ? matchFor(proposal, requests) : null,
      layoutName:
        ask.kind === "layout" && proposal.layoutName
          ? proposal.layoutName.trim().slice(0, 60) || null
          : null,
      dropped: failures.length,
    };
  } catch (error) {
    if (error instanceof AssistModelError) {
      throw new AssistModelError(error.message, error.temporary, true);
    }
    reportError("[ai] checking a proposal failed", error);
    throw new AssistModelError("The proposals could not be checked. Try again.", true, true);
  }
}
