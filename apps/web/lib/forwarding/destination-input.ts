import {
  EMAIL_TEMPLATE_ROOTS,
  REQUEST_TEMPLATE_ROOTS,
  unknownJsonPlaceholders,
  unknownPlaceholders,
  type Condition,
} from "@webhooks-cc/sdk";
import { conditionProblems } from "@/lib/rules";
import type { Json } from "@/lib/supabase/database";
import {
  ATTACHMENT_MODES,
  DESTINATION_FORMAT_SETTINGS,
  type DestinationAttachments,
  type DestinationChanges,
  type DestinationFormatSetting,
  type DestinationHeaderInput,
} from "@/lib/supabase/destinations";
import { allowPrivateTargets } from "./config";
import { checkOwnerHeaders } from "./owner-headers";
import { checkForwardUrl } from "./target";
import { checkSentField } from "./timing";

/**
 * Checks a destination as the API receives it (camelCase, every field
 * optional for a change; `url` required to create) and turns it into the
 * changes the data layer stores. Messages are for the person who sent it.
 */

const RETRY_CHOICES = [0, 3600, 86400];
const MAX_TEMPLATE_CHARS = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_NAME_CHARS = 100;
const MAX_SECONDS = 3600;
const MAX_MAILGUN_KEY_CHARS = 200;

export type DestinationInputResult =
  { ok: true; changes: DestinationChanges } | { ok: false; error: string };

function boolean(body: Record<string, unknown>, key: string): boolean | undefined | string {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : `${key} must be true or false.`;
}

function seconds(body: Record<string, unknown>, key: string): number | undefined | string {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SECONDS
    ? value
    : `${key} must be a whole number of seconds from 0 to ${MAX_SECONDS}.`;
}

/** The headers as submitted; a null value keeps what is stored under that name. */
export function checkHeadersInput(input: unknown): DestinationHeaderInput[] | string {
  if (!Array.isArray(input)) return "headers must be a list.";
  const named = input.map((item) => ({
    name: typeof item?.name === "string" ? item.name.trim() : "",
    // A placeholder stands in for values that stay as they are.
    value: item?.value === null || item?.value === undefined ? "kept" : item.value,
  }));
  const check = checkOwnerHeaders(named);
  if (!check.ok) return check.error;
  return input.map((item, index) => ({
    name: named[index].name,
    value: item?.value === null || item?.value === undefined ? null : String(item.value),
  }));
}

/** Template roots for the kinds a destination takes: a field of either kind is fine. */
function rootsFor(http: boolean, email: boolean): string[] {
  return [
    ...new Set([...(http ? REQUEST_TEMPLATE_ROOTS : []), ...(email ? EMAIL_TEMPLATE_ROOTS : [])]),
  ];
}

export function parseDestinationInput(
  body: Record<string, unknown>,
  options: {
    creating: boolean;
    /** The stored kinds, for checking templates when a change leaves them out. */
    current?: { http: boolean; email: boolean };
    /** Let private targets through (development); read from the environment when left out. */
    allowPrivate?: boolean;
  }
): DestinationInputResult {
  const fail = (error: string): DestinationInputResult => ({ ok: false, error });
  const changes: DestinationChanges = {};

  if (body.url !== undefined || options.creating) {
    if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 2048) {
      return fail("Enter the URL to send to.");
    }
    const url = body.url.trim();
    const check = checkForwardUrl(url, {
      allowPrivate: options.allowPrivate ?? allowPrivateTargets(),
    });
    if (!check.ok) return fail(check.reason);
    changes.url = url;
  }

  if (body.name !== undefined) {
    if (body.name === null || body.name === "") changes.name = null;
    else if (typeof body.name !== "string" || body.name.trim().length > MAX_NAME_CHARS) {
      return fail(`name is text of at most ${MAX_NAME_CHARS} characters.`);
    } else changes.name = body.name.trim() || null;
  }

  for (const key of ["enabled", "http", "email", "appendPath", "keepOrder"] as const) {
    const value = boolean(body, key);
    if (typeof value === "string") return fail(value);
    if (value !== undefined) changes[key] = value;
  }
  const http = changes.http ?? options.current?.http ?? true;
  const email = changes.email ?? options.current?.email ?? true;
  if (!http && !email) return fail("Pick at least one: HTTP requests or emails.");

  if (body.position !== undefined) {
    if (
      typeof body.position !== "number" ||
      !Number.isInteger(body.position) ||
      body.position < 0
    ) {
      return fail("position must be a whole number from 0.");
    }
    changes.position = body.position;
  }

  if (body.format !== undefined) {
    if (!(DESTINATION_FORMAT_SETTINGS as readonly unknown[]).includes(body.format)) {
      return fail(`format must be one of ${DESTINATION_FORMAT_SETTINGS.join(", ")}.`);
    }
    changes.format = body.format as DestinationFormatSetting;
  }

  if (body.filter !== undefined) {
    if (body.filter === null) changes.filter = null;
    else {
      if (typeof body.filter !== "object" || Array.isArray(body.filter)) {
        return fail("filter is { logic, conditions } or null.");
      }
      const filter = body.filter as { logic?: unknown; conditions?: unknown };
      if (filter.logic !== undefined && filter.logic !== "and" && filter.logic !== "or") {
        return fail('filter.logic must be "and" or "or".');
      }
      const problems = conditionProblems(filter.conditions, "filter", "filter.conditions");
      if (problems.length > 0) return fail(problems[0]);
      const conditions = filter.conditions as Condition[];
      changes.filter =
        conditions.length === 0
          ? null
          : { logic: filter.logic === "or" ? "or" : "and", conditions };
    }
  }

  const roots = rootsFor(http, email);
  if (body.bodyTemplate !== undefined) {
    if (body.bodyTemplate === null) changes.bodyTemplate = null;
    else {
      const text = JSON.stringify(body.bodyTemplate);
      if (text === undefined || text.length > MAX_TEMPLATE_CHARS) {
        return fail(`bodyTemplate is a JSON value of at most ${MAX_TEMPLATE_CHARS} characters.`);
      }
      const unknown = unknownJsonPlaceholders(body.bodyTemplate, roots);
      if (unknown.length > 0) {
        return fail(
          `${unknown.join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} of what this destination receives.`
        );
      }
      changes.bodyTemplate = body.bodyTemplate as Json;
    }
  }
  if (body.messageTemplate !== undefined) {
    if (body.messageTemplate === null || body.messageTemplate === "")
      changes.messageTemplate = null;
    else {
      if (
        typeof body.messageTemplate !== "string" ||
        body.messageTemplate.length > MAX_MESSAGE_CHARS
      ) {
        return fail(`messageTemplate is text of at most ${MAX_MESSAGE_CHARS} characters.`);
      }
      const unknown = unknownPlaceholders(body.messageTemplate, roots);
      if (unknown.length > 0) {
        return fail(
          `${unknown.join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} of what this destination receives.`
        );
      }
      changes.messageTemplate = body.messageTemplate;
    }
  }

  if (body.mailgunSigningKey !== undefined) {
    if (body.mailgunSigningKey === null || body.mailgunSigningKey === "") {
      changes.mailgunSigningKey = null;
    } else if (
      typeof body.mailgunSigningKey !== "string" ||
      body.mailgunSigningKey.trim().length > MAX_MAILGUN_KEY_CHARS
    ) {
      return fail(`mailgunSigningKey is text of at most ${MAX_MAILGUN_KEY_CHARS} characters.`);
    } else {
      changes.mailgunSigningKey = body.mailgunSigningKey.trim();
    }
  }

  if (body.headers !== undefined) {
    const headers = checkHeadersInput(body.headers);
    if (typeof headers === "string") return fail(headers);
    changes.headers = headers;
  }

  if (body.retrySeconds !== undefined) {
    if (!RETRY_CHOICES.includes(body.retrySeconds as number)) {
      return fail("retrySeconds must be 0, 3600 or 86400.");
    }
    changes.retrySeconds = body.retrySeconds as number;
  }

  if (body.sentField !== undefined) {
    if (body.sentField === null || body.sentField === "") changes.sentField = null;
    else if (typeof body.sentField !== "string") return fail("sentField must be text.");
    else {
      const problem = checkSentField(body.sentField.trim());
      if (problem) return fail(problem);
      changes.sentField = body.sentField.trim();
    }
  }

  for (const key of ["throttleSeconds", "delaySeconds"] as const) {
    const value = seconds(body, key);
    if (typeof value === "string") return fail(value);
    if (value !== undefined) changes[key] = value;
  }

  if (body.attachments !== undefined) {
    if (!(ATTACHMENT_MODES as readonly unknown[]).includes(body.attachments)) {
      return fail('attachments must be "links", "inline" or "none".');
    }
    changes.attachments = body.attachments as DestinationAttachments;
  }

  return { ok: true, changes };
}

/** A template destination needs its template; checked against the result of a change. */
export function templateProblem(next: {
  format: DestinationFormatSetting;
  bodyTemplate: Json | null;
}): string | null {
  return next.format === "template" &&
    (next.bodyTemplate === null || next.bodyTemplate === undefined)
    ? "A JSON template destination needs its bodyTemplate."
    : null;
}
