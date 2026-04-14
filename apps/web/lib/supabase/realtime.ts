import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "./client";
import type { Database } from "./database";

type UserRow = Database["public"]["Tables"]["users"]["Row"];
type EndpointRow = Database["public"]["Tables"]["endpoints"]["Row"];

let channelSequence = 0;

function nextChannelName(prefix: string): string {
  channelSequence += 1;
  return `${prefix}:${channelSequence}`;
}

function removeChannel(channel: RealtimeChannel) {
  const supabase = createClient();
  void supabase.removeChannel(channel);
}

export function subscribeToUserRow(userId: string, onChange: (row: UserRow | null) => void) {
  const supabase = createClient();
  const channel = supabase
    .channel(nextChannelName(`users:${userId}`))
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "users",
        filter: `id=eq.${userId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          onChange(null);
          return;
        }

        onChange(payload.new as UserRow);
      }
    )
    .subscribe();

  return () => removeChannel(channel);
}

export function subscribeToEndpointRequestInserts(endpointId: string, onChange: () => void) {
  const supabase = createClient();
  const channel = supabase
    .channel(nextChannelName(`requests:${endpointId}`))
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "requests",
        filter: `endpoint_id=eq.${endpointId}`,
      },
      () => onChange()
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "requests",
        filter: `endpoint_id=eq.${endpointId}`,
      },
      () => onChange()
    )
    .subscribe();

  return () => removeChannel(channel);
}

export function subscribeToEndpointRow(
  endpointId: string,
  onChange: (row: EndpointRow | null) => void
) {
  const supabase = createClient();
  const channel = supabase
    .channel(nextChannelName(`endpoint:${endpointId}`))
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "endpoints",
        filter: `id=eq.${endpointId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          onChange(null);
          return;
        }

        onChange(payload.new as EndpointRow);
      }
    )
    .subscribe();

  return () => removeChannel(channel);
}
