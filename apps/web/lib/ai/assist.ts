import type { Condition } from "@webhooks-cc/sdk";
import { htmlToText, type EmailField } from "@webhooks-cc/sdk/email";
import { emailFieldsProblems, emailFieldValues } from "@/lib/email-fields";
import { ruleSubjectFor } from "@/lib/request-context";
import { conditionsHold } from "@/lib/rules";
import type { RequestRecord } from "@/lib/supabase/requests";
import { proposePatterns, type Proposal } from "./model";

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

/** Samples at most, and how much of each part the model reads. */
export const MAX_SAMPLES = 5;
const MAX_PART_CHARS = 8_000;
const MAX_HEADERS = 40;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function cut(text: string | null | undefined, max = MAX_PART_CHARS): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)} [cut]` : text;
}

function addressText(
  list: { name?: string | null; address?: string | null }[] | undefined
): string {
  return (list ?? [])
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? "")))
    .join(", ");
}

/** A sample as the parts patterns read, cut to size; never attachments. */
export function sampleFor(request: RequestRecord): Record<string, unknown> {
  const email = request.email!;
  const text = email.text ?? null;
  const html = email.html ? htmlToText(email.html) : null;
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {})
      .slice(0, MAX_HEADERS)
      .map(([name, value]) => [name, cut(String(value), 200)])
  );
  return {
    subject: email.subject ?? "",
    from: addressText(email.from),
    to: addressText([...(email.to ?? []), ...(email.cc ?? [])]),
    text: cut(text ?? html),
    ...(html && html !== text ? { html: cut(html) } : {}),
    headers,
  };
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
  const passed: ProposedField[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const raw of proposal.fields.slice(0, 10)) {
    // A field asked for by name keeps that name, whatever the model called it.
    const name =
      ask.kind === "field" ? ask.name : ask.kind === "repair" ? ask.field.name : raw.name.trim();
    if (!FIELD_NAME.test(name) || seen.has(name)) {
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
    const values = requests.map(
      (request) => emailFieldValues(request, [field], { cache: false })?.[name] ?? null
    );
    const missed = values.flatMap((value, i) => (value === null ? [i + 1] : []));
    if (missed.length > 0) {
      failures.push(
        `${name} (${JSON.stringify(field.pattern)} on ${field.from}) found nothing in sample${missed.length === 1 ? "" : "s"} ${missed.join(", ")}.`
      );
      continue;
    }
    seen.add(name);
    passed.push({ field, values: values as string[] });
  }
  // Together they must stay small enough to run on every email.
  while (passed.length > 0 && emailFieldsProblems(passed.map((p) => p.field)).length > 0) {
    passed.pop();
  }
  return { passed, failures };
}

function matchFor(proposal: Proposal, requests: RequestRecord[]): Condition | null {
  const contains = proposal.match?.contains.trim();
  if (!proposal.match || !contains || contains.length > 200) return null;
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

/**
 * Proposes what was asked from the samples (emails of the endpoint, already
 * loaded and checked by the caller). Throws AssistModelError when the model
 * cannot be asked.
 */
export async function runAssist(ask: AssistAsk, requests: RequestRecord[]): Promise<AssistResult> {
  const samples = requests.map(sampleFor);
  const instruction = instructionFor(ask, samples.length);
  let proposal = await proposePatterns({ instruction, samples });
  let { passed, failures } = check(proposal, ask, requests);

  if (passed.length === 0 && failures.length > 0) {
    // Once more, with what went wrong.
    proposal = await proposePatterns({
      instruction,
      samples,
      feedback: `An earlier proposal failed when tested on the samples:\n- ${failures.slice(0, 10).join("\n- ")}\nPropose patterns that find the value in every sample.`,
    });
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
}
