import { authenticateRequest, convexCliRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 500;
const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;

  // Verify endpoint ownership
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
  const endpointId = (endpoint as { _id: string })._id;

  const encoder = new TextEncoder();
  let lastTimestamp = Date.now();
  const connectionStart = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connected event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ slug, endpointId })}\n\n`)
      );

      const abortSignal = request.signal;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
      };

      abortSignal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream may already be closed
        }
      });

      // Send keepalive pings
      keepaliveTimer = setInterval(() => {
        if (abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, KEEPALIVE_INTERVAL_MS);

      // Poll for new requests
      const poll = async () => {
        while (!abortSignal.aborted) {
          // Enforce max connection duration
          if (Date.now() - connectionStart > MAX_CONNECTION_DURATION_MS) {
            try {
              controller.enqueue(
                encoder.encode(
                  `event: timeout\ndata: ${JSON.stringify({ reason: "max_duration" })}\n\n`
                )
              );
            } catch {
              // Stream may already be closed by abort
            }
            break;
          }

          try {
            const resp = await convexCliRequest("/cli/requests-since", {
              params: {
                endpointId,
                userId: auth.userId,
                afterTimestamp: String(lastTimestamp),
              },
            });

            if (resp.ok) {
              const requests = await resp.json();
              if (Array.isArray(requests)) {
                for (const req of requests) {
                  if (abortSignal.aborted) break;
                  controller.enqueue(
                    encoder.encode(`event: request\ndata: ${JSON.stringify(req)}\n\n`)
                  );
                  if (req.receivedAt > lastTimestamp) {
                    lastTimestamp = req.receivedAt;
                  }
                }
              }
            }
          } catch {
            // Connection error during polling - continue
          }

          // Wait before next poll
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, POLL_INTERVAL_MS);
            abortSignal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        }

        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      };

      poll().catch((err) => {
        console.error("SSE poll loop error:", err);
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
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
