import type { Json } from "@/lib/supabase/database";
import {
  createApiKeyForUser,
  MAX_KEY_TTL_DAYS,
  parseKeyName,
  type CreatedApiKey,
} from "@/lib/supabase/api-keys";

/**
 * What an approval can ask for. Each action checks its parameters when the
 * approval is asked for, describes itself in one sentence and a few facts for
 * the page, and runs when the asker collects it (so a secret it makes, such
 * as a new API key, goes straight to the asker and is never stored).
 */
export type ApprovalAction = "api_keys.create";

export interface ActionDetail {
  label: string;
  value: string;
}

interface ActionSpec<P> {
  parse(input: unknown): { ok: true; params: P } | { ok: false; error: string };
  summary(params: P): string;
  details(params: P): ActionDetail[];
  /** What the asker gets (may hold a secret) and what the row keeps (never one). */
  run(userId: string, params: P): Promise<{ result: Record<string, unknown>; stored: Json }>;
}

/** An agent's key lives 90 days unless it asks for another lifetime (at most a year). */
export const DEFAULT_APPROVED_KEY_DAYS = 90;

interface KeyParams {
  name: string;
  expiresInDays: number;
}

const createApiKey: ActionSpec<KeyParams> = {
  parse(input) {
    const body = (input ?? {}) as Record<string, unknown>;
    const name = parseKeyName(body.name);
    if (!name.ok) return name;
    const days = body.expiresInDays ?? DEFAULT_APPROVED_KEY_DAYS;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_KEY_TTL_DAYS) {
      return {
        ok: false,
        error: `expiresInDays must be a whole number of days from 1 to ${MAX_KEY_TTL_DAYS}`,
      };
    }
    return { ok: true, params: { name: name.name, expiresInDays: days as number } };
  },
  summary: ({ name, expiresInDays }) =>
    `Create an API key named "${name}" with full access to your account for ${days(expiresInDays)}.`,
  details: ({ name, expiresInDays }) => [
    { label: "Key name", value: name },
    { label: "Works for", value: days(expiresInDays) },
    { label: "Access", value: "Everything an API key can do on your account" },
  ],
  async run(userId, { name, expiresInDays }) {
    const created: CreatedApiKey = await createApiKeyForUser(userId, name, expiresInDays);
    return {
      result: { ...created },
      stored: { keyPrefix: created.keyPrefix, expiresAt: created.expiresAt, name: created.name },
    };
  },
};

function days(count: number): string {
  if (count === 1) return "1 day";
  if (count % 365 === 0) return count === 365 ? "1 year" : `${count / 365} years`;
  return `${count} days`;
}

const ACTIONS: Record<ApprovalAction, ActionSpec<unknown>> = {
  "api_keys.create": createApiKey as ActionSpec<unknown>,
};

export function actionSpec(action: ApprovalAction): ActionSpec<unknown> {
  return ACTIONS[action];
}
