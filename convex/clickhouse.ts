/**
 * Convex action to proxy ClickHouse search requests.
 * The dashboard calls this action (which has Convex auth) to search
 * the Rust receiver's ClickHouse-backed /search endpoint.
 *
 * Requires RECEIVER_URL and CAPTURE_SHARED_SECRET env vars
 * set in the Convex dashboard.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";

export const search = action({
  args: {
    slug: v.optional(v.string()),
    method: v.optional(v.string()),
    q: v.optional(v.string()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    order: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const receiverUrl = process.env.RECEIVER_URL;
    const secret = process.env.CAPTURE_SHARED_SECRET;

    if (!receiverUrl || !secret) {
      // ClickHouse search not configured — return empty results
      return [];
    }

    const url = new URL(`${receiverUrl}/search`);
    url.searchParams.set("user_id", userId);

    if (args.slug) url.searchParams.set("slug", args.slug);
    if (args.method && args.method !== "ALL") url.searchParams.set("method", args.method);
    if (args.q) url.searchParams.set("q", args.q);
    if (args.from != null) url.searchParams.set("from", String(args.from));
    if (args.to != null) url.searchParams.set("to", String(args.to));
    if (args.limit != null) url.searchParams.set("limit", String(args.limit));
    if (args.offset != null) url.searchParams.set("offset", String(args.offset));
    if (args.order) url.searchParams.set("order", args.order);

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${secret}` },
      });

      if (!resp.ok) {
        console.error(`ClickHouse search failed: ${resp.status}`);
        return [];
      }

      return await resp.json();
    } catch (err) {
      console.error("ClickHouse search error:", err);
      return [];
    }
  },
});
