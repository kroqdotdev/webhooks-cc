import { nanoid } from "nanoid";
import { createAdminClient } from "./admin";
import type { Database, Json } from "./database";

const DEFAULT_EPHEMERAL_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_EPHEMERAL_ENDPOINTS = 500;
const MAX_SLUG_ATTEMPTS = 5;

type EndpointRow = Database["public"]["Tables"]["endpoints"]["Row"];
type EndpointInsert = Database["public"]["Tables"]["endpoints"]["Insert"];
type EndpointUpdate = Database["public"]["Tables"]["endpoints"]["Update"];
type SelectedEndpointRow = Pick<
  EndpointRow,
  | "id"
  | "user_id"
  | "slug"
  | "name"
  | "mock_response"
  | "is_ephemeral"
  | "expires_at"
  | "created_at"
>;
type OwnedEndpointRow = Pick<EndpointRow, "id" | "slug" | "user_id">;

export interface EndpointRecord {
  id: string;
  slug: string;
  name?: string;
  url?: string;
  mockResponse?: {
    status: number;
    body: string;
    headers: Record<string, string>;
    delay?: number;
  };
  isEphemeral?: boolean;
  expiresAt?: number;
  createdAt: number;
}

interface CreateEndpointInput {
  userId?: string;
  name?: string;
  isEphemeral?: boolean;
  expiresAt?: number;
  mockResponse?: Record<string, unknown>;
}

interface UpdateEndpointInput {
  userId: string;
  slug: string;
  name?: string;
  mockResponse?: Record<string, unknown> | null;
}

function webhookUrl(slug: string): string | undefined {
  const base = process.env.WEBHOOK_BASE_URL ?? process.env.NEXT_PUBLIC_WEBHOOK_URL;
  if (!base) return undefined;
  return `${base}/w/${slug}`;
}

function parseMillis(timestamp: string | null): number | undefined {
  if (!timestamp) return undefined;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeMockHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === "string")
  ) as Record<string, string>;
}

function normalizeEndpoint(row: SelectedEndpointRow): EndpointRecord {
  const mockResponse =
    row.mock_response && typeof row.mock_response === "object" && !Array.isArray(row.mock_response)
      ? row.mock_response
      : null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name ?? undefined,
    url: webhookUrl(row.slug),
    mockResponse:
      mockResponse && typeof mockResponse.status === "number"
        ? {
            status: mockResponse.status,
            body: typeof mockResponse.body === "string" ? mockResponse.body : "",
            headers: normalizeMockHeaders(mockResponse.headers),
            ...(typeof mockResponse.delay === "number" &&
            Number.isInteger(mockResponse.delay) &&
            mockResponse.delay > 0 &&
            mockResponse.delay <= 30000
              ? { delay: mockResponse.delay }
              : {}),
          }
        : undefined,
    isEphemeral: row.is_ephemeral || undefined,
    expiresAt: parseMillis(row.expires_at),
    createdAt: parseMillis(row.created_at) ?? Date.now(),
  };
}

async function generateUniqueSlug(): Promise<string> {
  const admin = createAdminClient();

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = nanoid(8);
    const { data, error } = await admin
      .from("endpoints")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return slug;
    }
  }

  throw new Error("Failed to generate unique slug");
}

async function findOwnedEndpoint(userId: string, slug: string): Promise<OwnedEndpointRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, slug, user_id")
    .eq("user_id", userId)
    .eq("slug", slug)
    .returns<OwnedEndpointRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function enforceEphemeralCapacity(): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { count, error } = await admin
    .from("endpoints")
    .select("id", { count: "exact", head: true })
    .eq("is_ephemeral", true)
    .gt("expires_at", nowIso);

  if (error) {
    throw error;
  }

  if ((count ?? 0) >= MAX_EPHEMERAL_ENDPOINTS) {
    throw new Error("Too many active demo endpoints. Please try again later.");
  }
}

export async function listEndpointsForUser(userId: string): Promise<EndpointRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, user_id, slug, name, mock_response, is_ephemeral, expires_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .returns<SelectedEndpointRow[]>();

  if (error) {
    throw error;
  }

  return (data ?? []).map(normalizeEndpoint);
}

export async function getEndpointBySlugForUser(
  userId: string,
  slug: string
): Promise<EndpointRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, user_id, slug, name, mock_response, is_ephemeral, expires_at, created_at")
    .eq("user_id", userId)
    .eq("slug", slug)
    .returns<SelectedEndpointRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeEndpoint(data) : null;
}

export async function createEndpointForUser({
  userId,
  name,
  isEphemeral = false,
  expiresAt,
  mockResponse,
}: CreateEndpointInput): Promise<EndpointRecord> {
  const admin = createAdminClient();
  const slug = await generateUniqueSlug();
  const ephemeral = isEphemeral || expiresAt !== undefined;

  if (ephemeral) {
    await enforceEphemeralCapacity();
  }

  const expiresAtIso =
    ephemeral && expiresAt !== undefined
      ? new Date(expiresAt).toISOString()
      : ephemeral
        ? new Date(Date.now() + DEFAULT_EPHEMERAL_TTL_MS).toISOString()
        : null;

  const insert: EndpointInsert = {
    user_id: userId ?? null,
    slug,
    name: name ?? null,
    mock_response: (mockResponse as Json | undefined) ?? null,
    is_ephemeral: ephemeral,
    expires_at: expiresAtIso,
  };

  const { data, error } = await admin
    .from("endpoints")
    .insert(insert)
    .select("id, user_id, slug, name, mock_response, is_ephemeral, expires_at, created_at")
    .returns<SelectedEndpointRow>()
    .single();

  if (error) {
    throw error;
  }

  return normalizeEndpoint(data);
}

export async function createGuestEndpoint(): Promise<EndpointRecord> {
  return createEndpointForUser({
    isEphemeral: true,
  });
}

export async function updateEndpointBySlugForUser({
  userId,
  slug,
  name,
  mockResponse,
}: UpdateEndpointInput): Promise<EndpointRecord | null> {
  const admin = createAdminClient();

  const updates: EndpointUpdate = {};
  if (name !== undefined) {
    updates.name = name;
  }
  if (mockResponse !== undefined) {
    updates.mock_response = mockResponse as Json | null;
  }

  const { data, error } = await admin
    .from("endpoints")
    .update(updates)
    .eq("user_id", userId)
    .eq("slug", slug)
    .select("id, user_id, slug, name, mock_response, is_ephemeral, expires_at, created_at")
    .returns<SelectedEndpointRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeEndpoint(data) : null;
}

export async function deleteEndpointBySlugForUser(userId: string, slug: string): Promise<boolean> {
  const admin = createAdminClient();
  const endpoint = await findOwnedEndpoint(userId, slug);

  if (!endpoint) {
    return false;
  }

  const { error: requestDeleteError } = await admin
    .from("requests")
    .delete()
    .eq("endpoint_id", endpoint.id);

  if (requestDeleteError) {
    throw requestDeleteError;
  }

  const { data, error } = await admin
    .from("endpoints")
    .delete()
    .eq("id", endpoint.id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return !!data;
}
