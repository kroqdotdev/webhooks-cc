import { opsJson } from "@/lib/staff";
import { tunnelConfig } from "./config";

/** The JSON body of an ops request, or a 400 to answer with. */
export async function opsBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {
    // Answered below.
  }
  return opsJson({ error: "Invalid JSON." }, { status: 400 });
}

/** What the sharing routes answer when sharing is not configured here. */
export function sharingOffForOps(): Response | null {
  return tunnelConfig()
    ? null
    : opsJson({ error: "Sharing is not configured on this server." }, { status: 503 });
}

/** "Stopped 2 previews." and friends, for staff. */
export function describeStopped(stopped: number, edgeReached: boolean): string {
  const what =
    stopped === 0
      ? "Nothing was live."
      : `Stopped ${stopped} ${stopped === 1 ? "preview" : "previews"}.`;
  return edgeReached || stopped === 0
    ? what
    : `${what} The edge did not answer; it closes them within 30 seconds.`;
}

/** A short reason staff give, 3 to 300 characters, or null. */
export function reasonOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 300 ? trimmed : null;
}
