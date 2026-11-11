import { serverEnv } from "@/lib/env";

/*
 * Tunnels (`whk share` previews and `whk tunnel --live`): the edge
 * (apps/edge-rs) holds the CLI's tunnels and serves previews, and the web
 * app is its control plane. Sharing is on only when the edge's secret and
 * the preview origin are set.
 */

export interface TunnelConfig {
  /** Shared with the edge: /api/edge/* and its control port. */
  edgeSecret: string;
  /** The edge's control port. */
  edgeUrl: string;
  /** "https://sharehooks.cc": a preview is this origin with its name before the host. */
  previewOrigin: URL;
}

/** The tunnel settings, or null when sharing is not configured here. */
export function tunnelConfig(): TunnelConfig | null {
  const env = serverEnv();
  if (!env.EDGE_SECRET || !env.SHARE_PREVIEW_ORIGIN) return null;
  return {
    edgeSecret: env.EDGE_SECRET,
    edgeUrl: env.EDGE_URL.replace(/\/+$/, ""),
    previewOrigin: new URL(env.SHARE_PREVIEW_ORIGIN),
  };
}

/** "https://acme.sharehooks.cc" for the name `acme` under `origin`. */
export function previewUrlFor(origin: URL, name: string): string {
  return `${origin.protocol}//${name}.${origin.host}`;
}

/** A preview's address, or null when sharing is not configured. */
export function previewUrl(name: string): string | null {
  const config = tunnelConfig();
  return config ? previewUrlFor(config.previewOrigin, name) : null;
}

/** What the API answers when sharing is not configured. */
export function sharingOff(): Response {
  return Response.json({ error: "Sharing is not available here." }, { status: 503 });
}
