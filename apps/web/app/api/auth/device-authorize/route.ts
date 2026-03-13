import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { createClient } from "@/lib/supabase/server";
import { authorizeDeviceCodeForUser } from "@/lib/supabase/device-auth";
import * as Sentry from "@sentry/nextjs";

export async function POST(request: Request) {
  const rateLimited = checkRateLimit(request, 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  if (typeof body.userCode !== "string") {
    return Response.json({ error: "Missing userCode" }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await authorizeDeviceCodeForUser(user.id, body.userCode);
    return Response.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Invalid code") ||
        error.message.includes("Code expired") ||
        error.message.includes("Code already used"))
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    Sentry.captureException(error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
