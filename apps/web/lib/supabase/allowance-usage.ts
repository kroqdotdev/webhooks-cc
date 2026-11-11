import { aiOffered } from "@/lib/ai/model";
import { reportError } from "@/lib/observability";
import { tunnelConfig } from "@/lib/tunnels/config";
import { tunnelPlanOf } from "@/lib/tunnels/plan";
import { usageOf } from "@/lib/tunnels/usage";
import { createAdminClient } from "./admin";
import { getCapacityState } from "./capacity-billing";

/** Parsed attachment pages in the account's page window (parsed_pages_balance()). */
export interface ParsedPagesUsage {
  used: number;
  /** The window's pages: the plan's (pro rata after an upgrade) plus monthly blocks. */
  limit: number;
  /** One-time pages left, used once `limit` is gone. */
  creditPages: number;
  /** Page overage this window, while `active`. */
  overage: { active: boolean; used: number; max: number };
  /** When the window ends; null until the first page of a monthly window is parsed. */
  resetsAt: string | null;
}

/** What visitors downloaded from `whk share` previews this UTC month. */
export interface PreviewDataUsage {
  bytes: number;
  limitBytes: number;
  /** Past the allowance: previews show a paused page until `resetsAt`. */
  over: boolean;
  resetsAt: string;
}

/** AI assists over the rolling 30 days, for endpoints no team pays for. */
export interface AiAssistsUsage {
  used: number;
  allowed: number;
  /** When the next counted assist stops counting; null when none is counted. */
  nextAt: string | null;
}

export interface AllowanceUsage {
  /** Null when it could not be read. */
  parsedPages: ParsedPagesUsage | null;
  /** Null when sharing is not set up on this server, or it could not be read. */
  previewData: PreviewDataUsage | null;
  /** Null when AI assists are not offered here, or they could not be read. */
  aiAssists: AiAssistsUsage | null;
}

/**
 * The account's other allowances beside requests, each with its own window:
 * parsed pages follow the page window, preview data the UTC month, and AI
 * assists a rolling 30 days. Each is read on its own and comes back null on
 * failure, so one missing table or function never fails the usage route.
 */
export async function getAllowanceUsage(userId: string): Promise<AllowanceUsage> {
  const [parsedPages, previewData, aiAssists] = await Promise.all([
    softly("parsed pages", () => parsedPagesOf(userId)),
    tunnelConfig() ? softly("preview data", () => previewDataOf(userId)) : null,
    aiOffered() ? softly("AI assists", () => aiAssistsOf(userId)) : null,
  ]);
  return { parsedPages, previewData, aiAssists };
}

async function softly<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    reportError(`[usage] reading ${what} failed`, error);
    return null;
  }
}

async function parsedPagesOf(userId: string): Promise<ParsedPagesUsage> {
  const state = await getCapacityState({ kind: "user", userId }, "pages");
  return {
    used: state.used,
    limit: state.planRequests + state.blockRequests,
    creditPages: state.creditRequests,
    overage: {
      active: state.overage.active,
      used: state.overage.usedRequests,
      max: state.overage.maxRequests,
    },
    resetsAt: state.periodEnd,
  };
}

async function previewDataOf(userId: string): Promise<PreviewDataUsage | null> {
  const plan = await tunnelPlanOf(userId);
  if (!plan) return null;
  const usage = await usageOf(plan, userId);
  return {
    bytes: usage.bytes,
    limitBytes: usage.allowanceBytes,
    over: usage.over,
    resetsAt: usage.resetsAt.toISOString(),
  };
}

async function aiAssistsOf(userId: string): Promise<AiAssistsUsage> {
  const { data, error } = await createAdminClient().rpc("ai_assists_left_for_user", {
    p_user_id: userId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { allowed?: number; used?: number; next_at?: string | null };
  const nextAt = typeof result.next_at === "string" ? new Date(result.next_at) : null;
  return {
    used: result.used ?? 0,
    allowed: result.allowed ?? 0,
    nextAt: nextAt && !Number.isNaN(nextAt.getTime()) ? nextAt.toISOString() : null,
  };
}
