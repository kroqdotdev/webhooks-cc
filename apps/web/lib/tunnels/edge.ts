import { tunnelConfig } from "./config";

/*
 * Calls to the edge's control port (apps/edge-rs/src/control.rs), with the
 * secret the edge uses towards us. Callers record the change first, so a
 * failed call only delays it: the edge asks about its shares every 30 seconds
 * (/api/edge/sync) and closes what has ended.
 */

export interface EdgeClose {
  shareId: string;
  /** Shown by the CLI: "The share closed: <reason>." */
  reason: string;
}

export interface EdgeGate {
  shareId: string;
  /** The password's version, or null for none (lib/tunnels/passwords.ts). */
  gate: string | null;
}

/** The edge's answer, or null when it did not answer or said no. */
async function ask(path: string, body: unknown): Promise<Response | null> {
  const config = tunnelConfig();
  if (!config) return null;
  try {
    const answer = await fetch(`${config.edgeUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.edgeSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (answer.ok) return answer;
    // Drained, never cancelled: Next's patched fetch tees the body.
    await answer.arrayBuffer().catch(() => undefined);
    return null;
  } catch (err) {
    console.warn(`[edge] ${path} not delivered`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function post(path: string, body: unknown): Promise<boolean> {
  const answer = await ask(path, body);
  if (!answer) return false;
  await answer.arrayBuffer().catch(() => undefined);
  return true;
}

/**
 * Closes per request to the control port. Its body limit is 64 KiB, and a
 * close carries up to about 250 characters of words for the CLI, so a bulk
 * stop (a team's subscription lapsing) goes in parts that each fit.
 */
export const CLOSES_PER_REQUEST = 100;

/** Closes shares at the edge now. False when the edge did not answer every part. */
export async function closeOnEdge(closes: EdgeClose[]): Promise<boolean> {
  let reached = true;
  for (let i = 0; i < closes.length; i += CLOSES_PER_REQUEST) {
    const part = closes.slice(i, i + CLOSES_PER_REQUEST);
    if (!(await post("/close", { closes: part }))) reached = false;
  }
  return reached;
}

/** Puts live shares behind a new password, or none, at the edge now. */
export async function gatesOnEdge(gates: EdgeGate[]): Promise<boolean> {
  if (gates.length === 0) return true;
  return post("/gate", { gates });
}

/** One request to a share as the edge saw it. */
export interface SeenRequest {
  /** Milliseconds since 1970. */
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  country: string | null;
  device: "phone" | "tablet" | "computer" | "bot" | "unknown";
  /** 1 for the first visitor seen, 2 for the next. */
  visitor: number;
}

/** What visitors did at one share, since the edge started. */
export interface Activity {
  /** The last requests, newest first. */
  requests: SeenRequest[];
  visitors: number;
  total: { requests: number; bytes: number };
}

/**
 * What visitors did at these shares, by id, from the edge's memory (nothing
 * survives its restart). Null when the edge did not answer.
 */
export async function recentRequests(ids: string[]): Promise<Record<string, Activity> | null> {
  const all: Record<string, Activity> = {};
  // The edge answers about a hundred at a time.
  for (let i = 0; i < ids.length; i += 100) {
    const answer = await ask("/requests", { ids: ids.slice(i, i + 100) });
    if (!answer) return null;
    const body = (await answer.json().catch(() => null)) as {
      activity?: Record<string, Activity>;
    } | null;
    if (!body?.activity) return null;
    Object.assign(all, body.activity);
  }
  return all;
}
