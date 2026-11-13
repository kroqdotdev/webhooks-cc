import { authenticateRequest } from "@/lib/api-auth";
import { serverEnv } from "@/lib/env";
import { checkRateLimitWithInfo, applyRateLimitHeaders, getClientIp } from "@/lib/rate-limit";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_LENGTH = 1_048_576; // 1MB, matches receiver limit
// Room for the largest body allowed however JSON escapes it (six bytes a
// character at most), so "Body too large" below still answers one a little
// over the limit.
const MAX_REQUEST_BYTES = 6 * MAX_BODY_LENGTH + 64 * 1024;

// The method and path are read as strings, so anything else is refused here.
// The rest is checked below or handed to fetch as it came, as before.
const sendTestBody = z.object({
  method: z.string().nullish(),
  slug: z.unknown().optional(),
  path: z.string().nullish(),
  headers: z.unknown().optional(),
  body: z.unknown().optional(),
});
// Headers the receiver reads the client IP from; callers must not be able to set them.
const IP_HEADERS = new Set([
  "x-real-ip",
  "x-forwarded-for",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "forwarded",
]);

export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitWithInfo(request, "send-test", 30); // 30 sends per minute
  if (rateLimit.response) return rateLimit.response;

  const parsed = await parseJsonBodyWith(request, sendTestBody, {
    message: "Invalid JSON",
    maxSize: MAX_REQUEST_BYTES,
  });
  if ("error" in parsed) return parsed.error;

  const { method, slug, path } = parsed.data;
  const headers = parsed.data.headers as Record<string, string> | null | undefined;
  const body = parsed.data.body as string | null | undefined;

  if (!method || !ALLOWED_METHODS.has(method.toUpperCase())) {
    return Response.json({ error: "Invalid method" }, { status: 400 });
  }

  if (!slug || !SLUG_REGEX.test(String(slug))) {
    return Response.json({ error: "Invalid slug" }, { status: 400 });
  }

  if (body && body.length > MAX_BODY_LENGTH) {
    return Response.json({ error: "Body too large" }, { status: 400 });
  }

  // Sanitize path: block traversal sequences
  const normalizedPath = !path || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  if (normalizedPath.includes("..")) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  // Build the receiver URL (internal, bypassing Cloudflare which intercepts 5xx)
  const url = `${serverEnv().RECEIVER_INTERNAL_URL}/w/${String(slug)}${normalizedPath}`;

  // Forward the caller's real IP so the receiver stores it on the request
  const resolvedIp = getClientIp(request);
  const clientIp = resolvedIp === "unknown" ? "" : resolvedIp;

  // Never let the caller dictate the stored client IP: drop any IP-carrying
  // header from the user-supplied set (fetch would otherwise join a caller's
  // `x-real-ip` with ours), then set ours.
  const forwardedHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !IP_HEADERS.has(name.toLowerCase()))
  );

  // Forward to the receiver
  const fetchHeaders: Record<string, string> = {
    ...forwardedHeaders,
    "X-Webhooks-CC-Test-Send": "1",
    ...(clientIp && { "X-Real-Ip": clientIp }),
  };

  try {
    const upstream = await fetch(url, {
      method: method.toUpperCase(),
      headers: fetchHeaders,
      body: method.toUpperCase() === "GET" ? undefined : (body ?? undefined),
    });

    const responseBody = await upstream.text();

    return applyRateLimitHeaders(
      Response.json({
        status: upstream.status,
        statusText: upstream.statusText,
        body: responseBody,
      }),
      rateLimit
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream fetch failed";
    return applyRateLimitHeaders(Response.json({ error: message }, { status: 502 }), rateLimit);
  }
}
