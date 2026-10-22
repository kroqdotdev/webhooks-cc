import { createAdminClient } from "./admin";

/** Endpoints named in the email and banner; the rest are summarized as a count. */
export const QUOTA_REJECTION_ENDPOINT_LIMIT = 5;

export interface QuotaRejectedEndpoint {
  slug: string;
  rejected: number;
}

export interface QuotaRejections {
  /** Webhooks rejected with 429 this period, across every affected endpoint. */
  total: number;
  /** How many endpoints had a rejection, including ones not in `endpoints`. */
  endpointCount: number;
  /** The most rejected endpoints, most rejected first. */
  endpoints: QuotaRejectedEndpoint[];
}

export const NO_QUOTA_REJECTIONS: QuotaRejections = { total: 0, endpointCount: 0, endpoints: [] };

/**
 * This period's quota rejections for one user's own, owner-billed endpoints,
 * read from endpoint_daily_stats (get_quota_rejections(), migration 00060).
 * Counts are per UTC day, so the first day of a period can include a few
 * rejections from just before it began.
 */
export async function getQuotaRejections(
  userId: string,
  limit: number = QUOTA_REJECTION_ENDPOINT_LIMIT
): Promise<QuotaRejections> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_quota_rejections", {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return NO_QUOTA_REJECTIONS;

  // bigint columns arrive as numbers from PostgREST; counts stay far below 2^53.
  return {
    total: Number(rows[0].total_rejected),
    endpointCount: Number(rows[0].endpoint_count),
    endpoints: rows.map((row) => ({ slug: row.slug, rejected: Number(row.quota_rejected) })),
  };
}
