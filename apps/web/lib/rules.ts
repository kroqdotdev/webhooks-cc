import { RE2JS } from "re2js";
import {
  conditionsIssues,
  evaluateConditions,
  globToRegexSource,
  MAX_PATTERN_CHARS,
  type ConditionGroup,
  type RegexTester,
  type RuleSubject,
} from "@webhooks-cc/sdk";

/**
 * Conditions as the web app evaluates them: the SDK's rule language
 * (packages/sdk/src/rules.ts, the same vectors as the receiver) with
 * regular expressions run by RE2. JavaScript's RegExp backtracks, and these
 * patterns run against whatever anyone sends to an endpoint; RE2 takes time
 * linear in the input, as the receiver's `regex` crate does.
 */

/** Compiled patterns; emptied when full. */
const compiledPatterns = new Map<string, RE2JS | null>();
const MAX_COMPILED = 512;

/**
 * The longest source compiled. Patterns are held to MAX_PATTERN_CHARS when
 * saved and evaluated, but a glob reaches the tester as the regex it
 * expands to (each `*` becomes `[^/]*`), up to five times as long.
 */
const MAX_SOURCE_CHARS = MAX_PATTERN_CHARS * 5 + 8;

function compile(pattern: string): RE2JS | null {
  if (pattern.length > MAX_SOURCE_CHARS) return null;
  const cached = compiledPatterns.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RE2JS | null = null;
  try {
    compiled = RE2JS.compile(pattern);
  } catch {
    compiled = null;
  }
  if (compiledPatterns.size >= MAX_COMPILED) compiledPatterns.clear();
  compiledPatterns.set(pattern, compiled);
  return compiled;
}

/** Searches `text` with an RE2 pattern; a pattern that does not compile never matches. */
export const re2Tester: RegexTester = (pattern, text) => {
  const compiled = compile(pattern);
  return compiled !== null && compiled.matcher(text).find();
};

/** Why a pattern is not valid RE2, or null when it is. */
export function regexProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_CHARS) return `longer than ${MAX_PATTERN_CHARS} characters`;
  return sourceProblem(pattern);
}

/** Why a glob cannot run as the regex it expands to, or null when it can. */
export function globProblem(glob: string): string | null {
  return sourceProblem(`(?s)${globToRegexSource(glob)}`);
}

function sourceProblem(source: string): string | null {
  if (source.length > MAX_SOURCE_CHARS) return `longer than ${MAX_PATTERN_CHARS} characters`;
  try {
    RE2JS.compile(source);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^error parsing regexp: /, "");
  }
}

/** Evaluates conditions with RE2. */
export function conditionsHold(group: ConditionGroup, subject: RuleSubject): boolean {
  return evaluateConditions(group, subject, { regex: re2Tester });
}

/** Problems with conditions for `use`, with RE2 checking regular expressions. */
export function conditionProblems(
  conditions: unknown,
  use: "response" | "filter",
  prefix = "conditions"
): string[] {
  return conditionsIssues(
    conditions,
    { use, checkRegex: regexProblem, checkGlob: globProblem },
    prefix
  );
}
