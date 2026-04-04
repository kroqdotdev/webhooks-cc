import { checkRateLimit } from "@/lib/rate-limit";
import { createGuestEndpoint } from "@/lib/supabase/endpoints";

const ANON_ENDPOINT_RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const ANON_ENDPOINT_RATE_LIMIT_MAX = 20;

export async function POST(request: Request) {
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
