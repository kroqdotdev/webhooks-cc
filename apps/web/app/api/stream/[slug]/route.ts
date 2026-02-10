import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";
import { publicEnv } from "@/lib/env";
import { ConvexClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";

export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  // Verify endpoint ownership via Convex HTTP action (one-time check)
  const endpointResp = await convexCliRequest("/cli/endpoint-by-slug", {
    params: { slug, userId: auth.userId },
  });

  if (endpointResp.status !== 200) {
    return endpointResp;
  }

  const endpoint: unknown = await endpointResp.json();
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    !("_id" in endpoint) ||
    typeof (endpoint as Record<string, unknown>)._id !== "string"
  ) {
    return Response.json({ error: "Invalid endpoint data" }, { status: 502 });
  }
  const endpointId = (endpoint as { _id: string })._id as Id<"endpoints">;
  const userId = auth.userId;

  const encoder = new TextEncoder();
  const connectionStart = Date.now();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connected event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ slug, endpointId })}\n\n`)
      );

      const abortSignal = request.signal;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      let convex: ConvexClient | null = null;
      let currentUnsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (durationTimer) {
          clearTimeout(durationTimer);
          durationTimer = null;
        }
        if (currentUnsubscribe) {
          currentUnsubscribe();
          currentUnsubscribe = null;
        }
        if (convex) {
          convex.close().catch(() => {});
          convex = null;
        }
      };

      const closeStream = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream may already be closed
        }
      };

      abortSignal.addEventListener("abort", closeStream);

      // Send keepalive pings
      keepaliveTimer = setInterval(() => {
        if (abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closeStream();
        }
      }, KEEPALIVE_INTERVAL_MS);

      // Enforce max connection duration
      const remainingMs = Math.max(0, MAX_CONNECTION_DURATION_MS - (Date.now() - connectionStart));
      durationTimer = setTimeout(() => {
        if (abortSignal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: timeout\ndata: ${JSON.stringify({ reason: "max_duration" })}\n\n`
            )
          );
        } catch {
          // Stream may already be closed
        }
        closeStream();
      }, remainingMs);

      // Set up Convex real-time subscription
      try {
        convex = new ConvexClient(publicEnv().NEXT_PUBLIC_CONVEX_URL);
      } catch (err) {
        console.error("SSE: failed to create ConvexClient:", err);
        closeStream();
        return;
      }

      let afterTimestamp = connectionStart;
      const sentIds = new Set<string>();

      const subscribe = () => {
        if (!convex || abortSignal.aborted) return;

        currentUnsubscribe = convex.onUpdate(
          api.requests.listNewForStream,
          { endpointId, afterTimestamp, userId },
          (results) => {
            if (abortSignal.aborted) return;

            // null means endpoint was deleted
            if (results === null) {
              try {
                controller.enqueue(
                  encoder.encode(`event: endpoint_deleted\ndata: ${JSON.stringify({ slug })}\n\n`)
                );
              } catch {
                // Stream may already be closed
              }
              closeStream();
              return;
            }

            // Send only new requests (subscription returns cumulative results)
            for (const req of results) {
              if (sentIds.has(req._id)) continue;
              sentIds.add(req._id);
              try {
                controller.enqueue(
                  encoder.encode(`event: request\ndata: ${JSON.stringify(req)}\n\n`)
                );
              } catch {
                closeStream();
                return;
              }
              if (req.receivedAt > afterTimestamp) {
                afterTimestamp = req.receivedAt;
              }
            }

            // If we hit the take(100) limit, re-subscribe with advanced timestamp
            if (results.length >= 100) {
              if (currentUnsubscribe) {
                currentUnsubscribe();
                currentUnsubscribe = null;
              }
              sentIds.clear();
              subscribe();
            }
          },
          (err) => {
            console.error("SSE subscription error:", err);
          }
        );
      };

      subscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
