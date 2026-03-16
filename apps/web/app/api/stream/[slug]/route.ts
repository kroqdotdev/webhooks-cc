import { authenticateRequest } from "@/lib/api-auth";
import { serverEnv } from "@/lib/env";
import { getEndpointBySlugForUser } from "@/lib/supabase/endpoints";
import type { Database, Json } from "@/lib/supabase/database";
import { listNewRequestsForEndpointByUser, type RequestRecord } from "@/lib/supabase/requests";
import { sendError } from "@appsignal/nodejs";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_CONNECTION_DURATION_MS = 30 * 60 * 1000;

type RequestRow = Database["public"]["Tables"]["requests"]["Row"];

function createRealtimeAdminClient() {
  const env = serverEnv();
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function asStringRecord(value: Json): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

function parseMillis(timestamp: string): number {
  return Date.parse(timestamp);
}

function toRequestRecord(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    method: row.method,
    path: row.path,
    headers: asStringRecord(row.headers),
    body: row.body ?? undefined,
    queryParams: asStringRecord(row.query_params),
    contentType: row.content_type ?? undefined,
    ip: row.ip,
    size: row.size,
    receivedAt: parseMillis(row.received_at),
  };
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
    queryParams: record.queryParams,
    contentType: record.contentType,
    ip: record.ip,
    size: record.size,
    receivedAt: record.receivedAt,
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
  const auth = await authenticateRequest(request);
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

  const endpoint = await getEndpointBySlugForUser(auth.userId, slug);
  if (!endpoint) {
    return Response.json({ error: "Endpoint not found" }, { status: 404 });
  }

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
      const sentIds = new Set<string>();
      let afterTimestamp = since ?? connectionStart;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let requestsChannel: RealtimeChannel | null = null;
      let endpointChannel: RealtimeChannel | null = null;

      const cleanup = () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (durationTimer) {
          clearTimeout(durationTimer);
          durationTimer = null;
        }
        if (requestsChannel) {
          void supabase.removeChannel(requestsChannel);
          requestsChannel = null;
        }
        if (endpointChannel) {
          void supabase.removeChannel(endpointChannel);
          endpointChannel = null;
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
        if (closed || sentIds.has(record.id)) {
          return;
        }

        sentIds.add(record.id);
        afterTimestamp = Math.max(afterTimestamp, record.receivedAt);
        controller.enqueue(
          encoder.encode(`event: request\ndata: ${JSON.stringify(toStreamRequest(record))}\n\n`)
        );
      };

      abortSignal.addEventListener("abort", closeStream);

      keepaliveTimer = setInterval(() => {
        if (closed || abortSignal.aborted) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closeStream();
        }
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

      requestsChannel = supabase.channel(`stream:requests:${endpoint.id}:${connectionStart}`).on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "requests",
          filter: `endpoint_id=eq.${endpoint.id}`,
        },
        (payload) => {
          try {
            enqueueRequest(toRequestRecord(payload.new as RequestRow));
          } catch (error) {
            sendError(error instanceof Error ? error : new Error(String(error)));
          }
        }
      );

      endpointChannel = supabase.channel(`stream:endpoint:${endpoint.id}:${connectionStart}`).on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "endpoints",
          filter: `id=eq.${endpoint.id}`,
        },
        () => {
          try {
            controller.enqueue(
              encoder.encode(`event: endpoint_deleted\ndata: ${JSON.stringify({ slug })}\n\n`)
            );
          } catch {
            // Stream may already be closed.
          }
          closeStream();
        }
      );

      try {
        await Promise.all([waitForSubscribed(requestsChannel), waitForSubscribed(endpointChannel)]);

        let backlogCursor = afterTimestamp;

        while (!closed) {
          const backlog = await listNewRequestsForEndpointByUser({
            userId: auth.userId,
            slug,
            after: backlogCursor,
            limit: 100,
          });

          if (backlog === null) {
            controller.enqueue(
              encoder.encode(`event: endpoint_deleted\ndata: ${JSON.stringify({ slug })}\n\n`)
            );
            closeStream();
            return;
          }

          if (backlog.length === 0) {
            break;
          }

          for (const record of backlog) {
            enqueueRequest(record);
          }

          if (backlog.length < 100) {
            break;
          }

          backlogCursor = Math.max(backlogCursor, backlog[backlog.length - 1]!.receivedAt - 1);
        }
      } catch (error) {
        sendError(error instanceof Error ? error : new Error(String(error)));
        console.error("Failed to initialize SSE stream:", error);
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
