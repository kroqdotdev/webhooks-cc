import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { serverEnv } from "@/lib/env";
import { resolveEndpointAccess } from "@/lib/supabase/teams";
import type { Database } from "@/lib/supabase/database";
import {
  getRetainedRequestsByIds,
  listRequestsAfterCursorForEndpointByUser,
  type RequestRecord,
} from "@/lib/supabase/requests";
import { createStreamDrainer } from "@/lib/stream/drainer";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000;
const BACKLOG_PAGE_SIZE = 100;

function createRealtimeAdminClient() {
  const env = serverEnv();
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function toStreamRequest(record: RequestRecord) {
  return {
    _id: record.id,
    _creationTime: record.receivedAt,
    endpointId: record.endpointId,
    method: record.method,
    path: record.path,
    headers: record.headers,
    body: record.body,
    bodyRaw: record.bodyRaw,
    queryParams: record.queryParams,
    contentType: record.contentType,
    ip: record.ip,
    size: record.size,
    receivedAt: record.receivedAt,
    // The parsed email stays out of the stream; read it from /api/requests/{id}.
    kind: record.kind,
  };
}

async function waitForSubscribed(channel: RealtimeChannel): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for realtime subscription"));
    }, 10_000);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timeout);
        resolve();
      }

      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timeout);
        reject(new Error(`Realtime subscription failed with status ${status}`));
      }
    });
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { slug } = await params;
  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  const since =
    sinceRaw === null
      ? undefined
      : Number.isFinite(Number(sinceRaw)) && Number(sinceRaw) >= 0
        ? Number(sinceRaw)
        : NaN;

  if (Number.isNaN(since)) {
    return Response.json({ error: "Invalid since timestamp" }, { status: 400 });
  }

  const access = await resolveEndpointAccess(auth.userId, slug);
  if (!access) {
    return Response.json({ error: "Endpoint not found" }, { status: 404 });
  }
  const endpoint = { id: access.endpointId, slug };

  const encoder = new TextEncoder();
  const connectionStart = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: connected\ndata: ${JSON.stringify({ slug, endpointId: endpoint.id })}\n\n`
        )
      );

      const abortSignal = request.signal;
      const supabase = createRealtimeAdminClient();
      const afterTimestamp = since ?? connectionStart;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let channel: RealtimeChannel | null = null;

      const cleanup = () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (durationTimer) {
          clearTimeout(durationTimer);
          durationTimer = null;
        }
        if (channel) {
          void supabase.removeChannel(channel);
          channel = null;
        }
        void supabase.realtime.disconnect();
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream may already be closed.
        }
      };

      const enqueueRequest = (record: RequestRecord) => {
        if (closed) {
          return;
        }
        controller.enqueue(
          encoder.encode(`event: request\ndata: ${JSON.stringify(toStreamRequest(record))}\n\n`)
        );
      };

      const sendEndpointDeleted = () => {
        try {
          controller.enqueue(
            encoder.encode(`event: endpoint_deleted\ndata: ${JSON.stringify({ slug })}\n\n`)
          );
        } catch {
          // Stream may already be closed.
        }
        closeStream();
      };

      // What to send and when: see lib/stream/drainer.ts.
      const drainer = createStreamDrainer({
        afterTimestamp,
        readAfter: ({ after, cursor, limit }) =>
          listRequestsAfterCursorForEndpointByUser({
            userId: auth.userId,
            slug,
            after,
            cursor,
            limit,
          }),
        readByIds: (ids) => getRetainedRequestsByIds(endpoint.id, ids),
        send: enqueueRequest,
        gone: sendEndpointDeleted,
        isClosed: () => closed,
        onError: (error) => reportError("Failed to read SSE stream backlog", error),
        pageSize: BACKLOG_PAGE_SIZE,
      });

      abortSignal.addEventListener("abort", closeStream);

      // The keepalive also catches up, looking back over the late window, in
      // case Realtime dropped a signal.
      keepaliveTimer = setInterval(() => {
        if (closed || abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closeStream();
          return;
        }
        drainer.recheck();
      }, KEEPALIVE_INTERVAL_MS);

      durationTimer = setTimeout(
        () => {
          if (closed || abortSignal.aborted) return;
          try {
            controller.enqueue(
              encoder.encode(
                `event: timeout\ndata: ${JSON.stringify({ reason: "max_duration" })}\n\n`
              )
            );
          } catch {
            // Stream may already be closed.
          }
          closeStream();
        },
        Math.max(0, MAX_CONNECTION_DURATION_MS - (Date.now() - connectionStart))
      );

      // The service role passes the realtime.messages policy; access to the
      // endpoint was checked above.
      channel = supabase
        .channel(`endpoint:${endpoint.id}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ event, payload }) => {
          if (event === "request_created") {
            const id = (payload as { request_id?: unknown } | undefined)?.request_id;
            drainer.signal(typeof id === "string" ? id : null);
          } else if (event === "endpoint_deleted") {
            sendEndpointDeleted();
          }
        });

      try {
        await waitForSubscribed(channel);
        await drainer.drain();
      } catch (error) {
        reportError("Failed to initialize SSE stream", error);
        closeStream();
      }
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
