import { isbot } from "isbot";
import { checkRateLimit } from "@/lib/rate-limit";
import { createGuestEndpoint } from "@/lib/supabase/endpoints";

const ANON_ENDPOINT_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const ANON_ENDPOINT_RATE_LIMIT_MAX = 20;

export async function POST(request: Request) {
  // Crawlers and scripted clients don't need real endpoints, and letting them
  // create one per page render can exhaust the global ephemeral endpoint cap.
  // The page HTML is identical for everyone — only this side effect is skipped.
  const userAgent = request.headers.get("user-agent");
  if (!userAgent || isbot(userAgent)) {
    return Response.json(
      {
        error: "Guest endpoints aren't created for automated clients. Sign in free instead.",
        code: "automated_client",
      },
      { status: 403 }
    );
  }

  const rateLimited = await checkRateLimit(
    request,
    ANON_ENDPOINT_RATE_LIMIT_MAX,
    ANON_ENDPOINT_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const endpoint = await createGuestEndpoint();
    return Response.json({
      ...endpoint,
      requestCount: 0,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Too many active demo endpoints")) {
      return Response.json({ error: error.message }, { status: 429 });
    }

    console.error("Failed to create guest endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
