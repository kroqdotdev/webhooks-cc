import { createHash } from "node:crypto";
import { safeEqual } from "@/lib/crypto";
import { tunnelConfig } from "./config";

/**
 * Whether a call to /api/edge/* comes from the edge: `Authorization: Bearer
 * <EDGE_SECRET>`, compared in constant time. With no secret set, nothing is
 * let in.
 */
export function fromEdge(request: Request): boolean {
  const secret = tunnelConfig()?.edgeSecret;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hashing both keeps the secret's length out of the comparison's timing.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return safeEqual(a, b);
}

/** The answer to anyone else: the routes do not exist for them. */
export function notEdge(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}
