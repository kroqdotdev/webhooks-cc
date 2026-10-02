import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "./client";

// Live updates arrive as Realtime Broadcast signals on private topics, sent by
// database triggers (migration 00043). Payloads carry ids only; listeners
// re-read data through the authenticated routes. Joining a topic is authorized
// once, by the policy on realtime.messages.
//
//   endpoint:<id>  request_created, request_updated, endpoint_deleted
//   user:<id>      profile_changed

// supabase-js hands out one channel per topic, so components that listen to
// the same topic share it. The channel is removed shortly after its last
// listener leaves, so an effect that resubscribes right away reuses it instead
// of racing the asynchronous removal.
const CHANNEL_LINGER_MS = 1000;

type TopicEntry = {
  channel: RealtimeChannel;
  listeners: Set<(event: string) => void>;
  removeTimer?: ReturnType<typeof setTimeout>;
};

const topics = new Map<string, TopicEntry>();

function subscribeToTopic(topic: string, onEvent: (event: string) => void): () => void {
  let entry = topics.get(topic);
  if (!entry) {
    const listeners = new Set<(event: string) => void>();
    const channel = createClient()
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: "*" }, ({ event }) => {
        for (const listener of listeners) listener(event);
      })
      .subscribe();
    entry = { channel, listeners };
    topics.set(topic, entry);
  }

  const current = entry;
  clearTimeout(current.removeTimer);
  current.removeTimer = undefined;
  current.listeners.add(onEvent);

  return () => {
    current.listeners.delete(onEvent);
    if (current.listeners.size > 0 || current.removeTimer) return;
    current.removeTimer = setTimeout(() => {
      topics.delete(topic);
      void createClient().removeChannel(current.channel);
    }, CHANNEL_LINGER_MS);
  };
}

/** Calls `onChange` when a request on the endpoint is captured or its signature result lands. */
export function subscribeToEndpointRequestChanges(endpointId: string, onChange: () => void) {
  return subscribeToTopic(`endpoint:${endpointId}`, (event) => {
    if (event === "request_created" || event === "request_updated") onChange();
  });
}

/** Calls `onChange` when the user's plan, billing, or quota state changes. */
export function subscribeToUserProfileChanges(userId: string, onChange: () => void) {
  return subscribeToTopic(`user:${userId}`, (event) => {
    if (event === "profile_changed") onChange();
  });
}
