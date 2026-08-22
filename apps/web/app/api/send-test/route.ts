import { authenticateRequest } from "@/lib/api-auth";
import { serverEnv } from "@/lib/env";
import { checkRateLimitWithInfo, applyRateLimitHeaders, getClientIp } from "@/lib/rate-limit";

const SLUG_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_LENGTH = 1_048_576; // 1MB, matches receiver limit
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

  const rateLimit = await checkRateLimitWithInfo(request, 30); // 30 sends per minute
  if (rateLimit.response) return rateLimit.response;

  let payload: {
    method: string;
    slug: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { method, slug, path, headers, body } = payload;

  if (!method || !ALLOWED_METHODS.has(method.toUpperCase())) {
    return Response.json({ error: "Invalid method" }, { status: 400 });
  }

  if (!slug || !SLUG_REGEX.test(slug)) {
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
  const url = `${serverEnv().RECEIVER_INTERNAL_URL}/w/${slug}${normalizedPath}`;

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
      body: method.toUpperCase() === "GET" ? undefined : body,
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
