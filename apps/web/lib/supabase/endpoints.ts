import { storedEmailFields } from "@/lib/email-fields";
import { storedLayouts } from "@/lib/parsing/stored";
import type { EmailField, Layout } from "@webhooks-cc/sdk/email";
import { customAlphabet } from "nanoid";
import { decryptOwnerHeaders, maskOwnerHeaders } from "@/lib/forwarding/owner-headers";
import { createAdminClient } from "./admin";
import {
  applyLegacyForwarding,
  applyLegacyNotificationUrl,
  notificationDestination,
  primaryDestination,
} from "./destinations";
import { serverEnv } from "../env";
import type { Database, Json } from "./database";
import { isValidSigningHeaderName, isValidSigningProvider } from "@/lib/signing-config";

const MAX_SLUG_ATTEMPTS = 5;
const nanoidSlug = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

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
  | "response_rules"
  | "is_ephemeral"
  | "expires_at"
  | "created_at"
> & {
  signing_provider?: string | null;
  signing_secret_encrypted?: string | null;
  signing_header?: string | null;
  show_email_extracts?: boolean;
  email_fields?: Json;
  retention_days?: number | null;
  delete_after_delivery?: boolean;
  /** Computed column (migration 00068): the billing account's retention. */
  retention_cap?: number | null;
  layouts?: Json;
  /** Computed column (migration 00069): layouts the billing account's plan uses. */
  layouts_cap?: number | null;
  /** Embedded: the old forward* fields and notificationUrl read from these (migration 00063). */
  endpoint_destinations?: EmbeddedDestination[];
};
type EmbeddedDestination = Pick<
  Database["public"]["Tables"]["endpoint_destinations"]["Row"],
  | "id"
  | "position"
  | "created_at"
  | "legacy_role"
  | "enabled"
  | "url"
  | "http"
  | "email"
  | "format"
  | "headers_encrypted"
  | "append_path"
  | "retry_seconds"
  | "keep_order"
  | "sent_field"
  | "secret_encrypted"
>;
type OwnedEndpointRow = Pick<EndpointRow, "id" | "slug" | "user_id">;

const ENDPOINT_COLUMNS =
  "id, user_id, slug, name, mock_response, response_rules, is_ephemeral, expires_at, created_at, signing_provider, signing_secret_encrypted, signing_header, show_email_extracts, email_fields, retention_days, delete_after_delivery, retention_cap, layouts, layouts_cap, endpoint_destinations(id, position, created_at, legacy_role, enabled, url, http, email, format, headers_encrypted, append_path, retry_seconds, keep_order, sent_field, secret_encrypted)";
interface ExistingSigningConfigRow {
  signing_provider: string | null;
  signing_secret_encrypted: string | null;
  signing_header: string | null;
}

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
  responseRules?: unknown[];
  notificationUrl: string | null;
  isEphemeral?: boolean;
  expiresAt?: number;
  createdAt: number;
  /** Signing provider (e.g., "stripe", "github"). null = verification disabled. */
  signingProvider?: string | null;
  /** Whether a signing secret is configured (never exposes the secret itself). */
  hasSigningSecret?: boolean;
  /** Custom header name for generic-hmac provider. */
  signingHeader?: string | null;
  /** Address that delivers email to this endpoint. Endpoints without an owner get no email. */
  emailAddress?: string | null;
  /** Show the codes and links found in captured emails in the dashboard. */
  showEmailExtracts: boolean;
  /** Named fields picked out of every email (lib/email-fields.ts). */
  emailFields: EmailField[];
  /** Forwarding is on: the kinds below go to forwardUrl (lib/forwarding). */
  forwardEnabled: boolean;
  /** Owner-only, like notificationUrl. */
  forwardUrl: string | null;
  /** Whether a forwarding secret exists (never the secret itself). */
  hasForwardSecret: boolean;
  /** Which captured requests are forwarded. */
  forwardHttp: boolean;
  forwardEmail: boolean;
  /**
   * "auto" picks from the URL: chat for Slack and Discord, else as received
   * (HTTP) and signed JSON (email). "as_received" sends emails as signed JSON.
   */
  forwardFormat: ForwardFormatSetting;
  /** Append the path after the slug to forwardUrl (HTTP requests). */
  forwardAppendPath: boolean;
  /** Stop retrying after: 0 (one try), 3600 or 86400 seconds. */
  forwardRetrySeconds: number;
  /** One delivery at a time, in capture order. */
  forwardKeepOrder: boolean;
  /** The owner's headers: names and masked values (owner-only). */
  forwardHeaders: { name: string; value: string }[];
  /** The JSON body field holding when the sender sent a request (dots for nesting). */
  forwardSentField: string | null;
  /** How many destinations captures go to (lib/supabase/destinations.ts). */
  destinationCount: number;
  /** Days requests are kept here; null keeps them as long as the plan does. */
  retentionDays: number | null;
  /** The longest retention allowed: the billing account's plan. */
  retentionCapDays: number;
  /** Requests are deleted once every delivery is settled. */
  deleteAfterDelivery: boolean;
  /** How the endpoint reads its emails (lib/parsing/layouts.ts); the first that matches applies. */
  layouts: Layout[];
  /** Layouts the billing account's plan uses; later ones are kept but not used. */
  layoutsCap: number;
}

export type ForwardFormatSetting = "auto" | "as_received" | "json" | "chat";
export const FORWARD_FORMAT_SETTINGS: readonly ForwardFormatSetting[] = [
  "auto",
  "as_received",
  "json",
  "chat",
];
export const FORWARD_RETRY_CHOICES = [0, 3600, 86400] as const;

/** One header the owner submits; a null value keeps the stored value of that name. */
export interface ForwardHeaderInput {
  name: string;
  value: string | null;
}

/** Thrown when a submitted header keeps a value (null) that is not stored under its name. */
export { DestinationHeaderValueMissingError as ForwardHeaderValueMissingError } from "./destinations";

/** Thrown when a temporary endpoint cannot be created because the guest pool is full. */
export class EphemeralCapacityError extends Error {
  constructor() {
    super("Too many active demo endpoints. Please try again later.");
    this.name = "EphemeralCapacityError";
  }
}

interface CreateEndpointInput {
  userId?: string;
  name?: string;
  isEphemeral?: boolean;
  expiresAt?: number;
  mockResponse?: Record<string, unknown>;
  responseRules?: unknown[] | null;
  notificationUrl?: string;
}

interface UpdateEndpointInput {
  userId: string;
  slug: string;
  name?: string;
  mockResponse?: Record<string, unknown> | null;
  responseRules?: unknown[] | null;
  notificationUrl?: string | null;
  signingProvider?: string | null;
  /** Plaintext secret — encrypted before storage, never returned. */
  signingSecret?: string | null;
  signingHeader?: string | null;
  showEmailExtracts?: boolean;
  /** Validated by the route (lib/email-fields.ts). */
  emailFields?: EmailField[] | null;
  /** Validated by the route (lib/parsing/layouts.ts). */
  layouts?: Layout[] | null;
  forwardEnabled?: boolean;
  /** Validated by the route (lib/forwarding/target.ts). */
  forwardUrl?: string | null;
  forwardHttp?: boolean;
  forwardEmail?: boolean;
  forwardFormat?: ForwardFormatSetting;
  forwardAppendPath?: boolean;
  forwardRetrySeconds?: number;
  forwardKeepOrder?: boolean;
  /** The whole set; validated by the route (lib/forwarding/owner-headers.ts). */
  forwardHeaders?: ForwardHeaderInput[];
  /** Validated by the route (lib/forwarding/timing.ts); null clears it. */
  forwardSentField?: string | null;
  /** Validated by the route against the account's retention; null keeps the plan's. */
  retentionDays?: number | null;
  deleteAfterDelivery?: boolean;
}

/** Endpoints without an owner get no email: guest captures are readable by anyone with the slug. */
export function emailAddress(slug: string, userId: string | null): string | null {
  return userId ? `${slug}@${serverEnv().EMAIL_CAPTURE_DOMAIN}` : null;
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
  const destinations = [...(row.endpoint_destinations ?? [])]
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .map((destination) => ({ ...destination, role: destination.legacy_role }));
  const primary = primaryDestination(destinations);
  const notify = notificationDestination(destinations);
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
    responseRules:
      Array.isArray(row.response_rules) && row.response_rules.length > 0
        ? (row.response_rules as unknown[])
        : undefined,
    notificationUrl: notify?.url ?? null,
    isEphemeral: row.is_ephemeral || undefined,
    expiresAt: parseMillis(row.expires_at),
    createdAt: parseMillis(row.created_at) ?? Date.now(),
    signingProvider: row.signing_provider ?? null,
    hasSigningSecret: !!row.signing_secret_encrypted,
    signingHeader: row.signing_header ?? null,
    emailAddress: emailAddress(row.slug, row.user_id),
    showEmailExtracts: row.show_email_extracts ?? true,
    emailFields: storedEmailFields(row.email_fields),
    forwardEnabled: primary?.enabled ?? false,
    forwardUrl: primary?.url ?? null,
    hasForwardSecret: !!primary?.secret_encrypted,
    forwardHttp: primary?.http ?? false,
    forwardEmail: primary?.email ?? true,
    // Templates and provider shapes are newer than this field; older clients see the URL's pick.
    forwardFormat:
      primary?.format === "as_received" || primary?.format === "json" || primary?.format === "chat"
        ? primary.format
        : "auto",
    forwardAppendPath: primary?.append_path ?? true,
    forwardRetrySeconds: primary?.retry_seconds ?? 86400,
    forwardKeepOrder: primary?.keep_order ?? false,
    forwardHeaders: maskedForwardHeaders(primary?.headers_encrypted),
    forwardSentField: primary?.sent_field ?? null,
    destinationCount: destinations.length,
    retentionDays: row.retention_days ?? null,
    retentionCapDays: row.retention_cap ?? 7,
    deleteAfterDelivery: row.delete_after_delivery ?? false,
    layouts: storedLayouts(row.layouts),
    layoutsCap: row.layouts_cap ?? 0,
  };
}

/** The owner's headers as the dashboard shows them; never the values. */
function maskedForwardHeaders(
  encrypted: string | null | undefined
): { name: string; value: string }[] {
  if (!encrypted) return [];
  try {
    return maskOwnerHeaders(decryptOwnerHeaders(byteaToBuffer(encrypted)));
  } catch {
    return [];
  }
}

/** PostgREST returns bytea as "\\x..." hex text. */
function byteaToBuffer(value: string): Buffer {
  return value.startsWith("\\x")
    ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value, "base64");
}

async function generateUniqueSlug(): Promise<string> {
  const admin = createAdminClient();

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = nanoidSlug();
    const { data, error } = await admin
      .from("endpoints")
      .select("id")
      .eq("slug", slug.toLowerCase())
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
    .eq("slug", slug.toLowerCase())
    .returns<OwnedEndpointRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

/** Agent sandbox endpoints have a pool of their own (create_sandbox_endpoint). */
async function enforceEphemeralCapacity(): Promise<void> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("endpoints")
    .select("id", { count: "exact", head: true })
    .eq("is_ephemeral", true)
    .gt("expires_at", new Date().toISOString())
    .is("agent_registration_id", null);

  if (error) {
    throw error;
  }

  if ((count ?? 0) >= serverEnv().MAX_EPHEMERAL_ENDPOINTS) {
    throw new EphemeralCapacityError();
  }
}

export async function listEndpointsForUser(userId: string): Promise<EndpointRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select(ENDPOINT_COLUMNS)
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
    .select(ENDPOINT_COLUMNS)
    .eq("user_id", userId)
    .eq("slug", slug.toLowerCase())
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
  responseRules,
  notificationUrl,
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
        ? new Date(Date.now() + serverEnv().EPHEMERAL_TTL_HOURS * 60 * 60 * 1000).toISOString()
        : null;

  const insert: EndpointInsert = {
    user_id: userId ?? null,
    slug,
    name: name ?? null,
    mock_response: (mockResponse as Json | undefined) ?? null,
    response_rules: (responseRules as Json | undefined) ?? null,
    is_ephemeral: ephemeral,
    expires_at: expiresAtIso,
  };

  const { data, error } = await admin
    .from("endpoints")
    .insert(insert)
    .select(ENDPOINT_COLUMNS)
    .returns<SelectedEndpointRow>()
    .single();

  if (error) {
    throw error;
  }

  // A notification URL is a chat destination (lib/supabase/destinations.ts).
  if (notificationUrl && userId) {
    const created = data as SelectedEndpointRow;
    await applyLegacyNotificationUrl(created.id, notificationUrl);
    const { data: reread, error: rereadError } = await admin
      .from("endpoints")
      .select(ENDPOINT_COLUMNS)
      .eq("id", created.id)
      .returns<SelectedEndpointRow>()
      .single();
    if (rereadError) throw rereadError;
    return normalizeEndpoint(reread);
  }

  return normalizeEndpoint(data);
}

/**
 * Guest-visible endpoint lookup. Only unowned ephemeral endpoints qualify:
 * signed-in users (and the SDK's `ephemeral: true`) create owned ephemeral
 * endpoints too, and those must never be readable without authentication.
 * Agent sandbox endpoints are unowned as well, but only their registration's
 * token may read them.
 */
export async function getGuestEndpointBySlug(slug: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("id, slug, is_ephemeral, expires_at, request_count")
    .eq("slug", slug.toLowerCase())
    .eq("is_ephemeral", true)
    .is("user_id", null)
    .is("agent_registration_id", null)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function createGuestEndpoint(): Promise<EndpointRecord> {
  return createEndpointForUser({
    isEphemeral: true,
  });
}

/**
 * Claim an ephemeral guest endpoint for an authenticated user.
 * Assigns the user_id, clears the ephemeral flag, and removes the expiry.
 * Returns the updated endpoint, or null if the slug doesn't exist or isn't ephemeral.
 */
export async function claimGuestEndpoint(
  userId: string,
  slug: string
): Promise<EndpointRecord | null> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Only claim endpoints that are ephemeral, have no owner, and haven't expired
  const { data, error } = await admin
    .from("endpoints")
    .update({
      user_id: userId,
      is_ephemeral: false,
      expires_at: null,
    })
    .eq("slug", slug.toLowerCase())
    .is("user_id", null)
    .eq("is_ephemeral", true)
    .gt("expires_at", nowIso)
    .is("agent_registration_id", null)
    .select(ENDPOINT_COLUMNS)
    .returns<SelectedEndpointRow>()
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeEndpoint(data) : null;
}

export async function updateEndpointBySlugForUser({
  userId,
  slug,
  name,
  mockResponse,
  responseRules,
  notificationUrl,
  signingProvider,
  signingSecret,
  signingHeader,
  showEmailExtracts,
  emailFields,
  layouts,
  forwardEnabled,
  forwardUrl,
  forwardHttp,
  forwardEmail,
  forwardFormat,
  forwardAppendPath,
  forwardRetrySeconds,
  forwardKeepOrder,
  forwardHeaders,
  forwardSentField,
  retentionDays,
  deleteAfterDelivery,
}: UpdateEndpointInput): Promise<EndpointRecord | null> {
  const admin = createAdminClient();

  let existingSigningProvider: string | null = null;
  let existingSigningSecretEncrypted: string | null = null;
  let existingSigningHeader: string | null = null;
  const signingConfigTouched =
    signingProvider !== undefined || signingSecret !== undefined || signingHeader !== undefined;
  if (signingConfigTouched) {
    const { data, error } = await admin
      .from("endpoints")
      .select("signing_provider, signing_secret_encrypted, signing_header")
      .eq("user_id", userId)
      .eq("slug", slug.toLowerCase())
      .returns<ExistingSigningConfigRow>()
      .maybeSingle();

    if (error) {
      throw error;
    }

    const row = data as ExistingSigningConfigRow | null;
    if (!row) {
      return null;
    }

    existingSigningProvider = row.signing_provider;
    existingSigningSecretEncrypted = row.signing_secret_encrypted;
    existingSigningHeader = row.signing_header;
  }

  const nextSigningProvider =
    signingProvider === undefined ? existingSigningProvider : signingProvider;
  const signingProviderChanged =
    signingProvider !== undefined && signingProvider !== existingSigningProvider;
  const hasNewSigningSecret =
    signingSecret !== undefined && signingSecret !== null && signingSecret !== "";
  const hasStoredSecretForSelectedProvider =
    !signingProviderChanged && !!existingSigningSecretEncrypted;

  if (nextSigningProvider && signingSecret === null) {
    throw new Error("Cannot clear signing secret while signature verification is enabled");
  }

  if (nextSigningProvider && !isValidSigningProvider(nextSigningProvider)) {
    throw new Error("Invalid signing provider");
  }

  if (!nextSigningProvider && hasNewSigningSecret) {
    throw new Error("Signing provider is required before saving a signing secret");
  }

  if (nextSigningProvider && !hasNewSigningSecret && !hasStoredSecretForSelectedProvider) {
    throw new Error("Signing secret is required when configuring a signing provider");
  }

  if (nextSigningProvider === "generic-hmac") {
    const nextSigningHeader = signingHeader === undefined ? existingSigningHeader : signingHeader;
    if (!isValidSigningHeaderName(nextSigningHeader)) {
      throw new Error("Generic HMAC requires a signing header");
    }
  }

  const updates: EndpointUpdate = {};
  if (name !== undefined) {
    updates.name = name;
  }
  if (mockResponse !== undefined) {
    updates.mock_response = mockResponse as Json | null;
  }
  if (responseRules !== undefined) {
    updates.response_rules = responseRules as Json | null;
  }
  if (showEmailExtracts !== undefined) {
    updates.show_email_extracts = showEmailExtracts;
  }
  if (emailFields !== undefined) {
    updates.email_fields = (emailFields ?? []) as unknown as Json;
  }
  if (layouts !== undefined) {
    updates.layouts = (layouts ?? []) as unknown as Json;
  }
  if (retentionDays !== undefined) {
    updates.retention_days = retentionDays;
  }
  if (deleteAfterDelivery !== undefined) {
    updates.delete_after_delivery = deleteAfterDelivery;
  }
  // Handle signing config
  if (signingProvider !== undefined) {
    if (signingProvider === null) {
      // Clearing signing config — wipe everything
      updates.signing_provider = null;
      updates.signing_secret_encrypted = null;
      updates.signing_header = null;
    } else {
      updates.signing_provider = signingProvider;
      // Only process secret/header when not clearing
      if (signingSecret !== undefined && signingSecret !== null && signingSecret !== "") {
        const { encryptSigningSecret } = await import("@/lib/crypto");
        const encrypted = encryptSigningSecret(signingSecret);
        // Supabase PostgREST expects hex-encoded bytea with \\x prefix
        updates.signing_secret_encrypted = `\\x${encrypted.toString("hex")}`;
      } else if (signingSecret === null) {
        updates.signing_secret_encrypted = null;
      }
      if (signingHeader !== undefined) {
        updates.signing_header = signingProvider === "generic-hmac" ? signingHeader || null : null;
      } else if (signingProvider !== "generic-hmac") {
        updates.signing_header = null;
      }
    }
  } else {
    // Provider not being changed — still allow updating secret/header independently
    if (signingSecret !== undefined && signingSecret !== null && signingSecret !== "") {
      const { encryptSigningSecret } = await import("@/lib/crypto");
      const encrypted = encryptSigningSecret(signingSecret);
      updates.signing_secret_encrypted = `\\x${encrypted.toString("hex")}`;
    } else if (signingSecret === null) {
      updates.signing_secret_encrypted = null;
    }
    if (signingHeader !== undefined && nextSigningProvider === "generic-hmac") {
      updates.signing_header = signingHeader || null;
    } else if (signingHeader !== undefined && nextSigningProvider !== "generic-hmac") {
      updates.signing_header = null;
    }
  }

  const forwarding = {
    forwardEnabled,
    forwardUrl,
    forwardHttp,
    forwardEmail,
    forwardFormat,
    forwardAppendPath,
    forwardRetrySeconds,
    forwardKeepOrder,
    forwardHeaders,
    forwardSentField,
  };
  const forwardingTouched = Object.values(forwarding).some((value) => value !== undefined);
  if (forwardingTouched || notificationUrl !== undefined) {
    const owned = await findOwnedEndpoint(userId, slug);
    if (!owned) return null;
    // The old fields stand for destinations now (lib/supabase/destinations.ts).
    if (forwardingTouched) await applyLegacyForwarding(owned.id, forwarding);
    if (notificationUrl !== undefined) await applyLegacyNotificationUrl(owned.id, notificationUrl);
  }

  const { data, error } =
    Object.keys(updates).length > 0
      ? await admin
          .from("endpoints")
          .update(updates)
          .eq("user_id", userId)
          .eq("slug", slug.toLowerCase())
          .select(ENDPOINT_COLUMNS)
          .returns<SelectedEndpointRow>()
          .maybeSingle()
      : await admin
          .from("endpoints")
          .select(ENDPOINT_COLUMNS)
          .eq("user_id", userId)
          .eq("slug", slug.toLowerCase())
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

// ---------------------------------------------------------------------------
// Agent sandbox endpoints (auth.md v0.6). They belong to an agent
// registration, never to a user, and expire with it. Every read is scoped by
// the registration id taken from the bearer's api_keys row, which the agent
// never sees.
// ---------------------------------------------------------------------------

type SandboxEndpointRow = SelectedEndpointRow & { request_count: number };

export interface SandboxEndpointRecord extends EndpointRecord {
  requestCount: number;
}

const SANDBOX_ENDPOINT_COLUMNS = `${ENDPOINT_COLUMNS}, request_count`;

function normalizeSandboxEndpoint(row: SandboxEndpointRow): SandboxEndpointRecord {
  return { ...normalizeEndpoint(row), requestCount: row.request_count };
}

export type CreateSandboxEndpointResult =
  | { status: "ok"; endpoint: SandboxEndpointRecord }
  | { status: "registration_inactive" }
  | { status: "endpoint_limit" }
  | { status: "pool_full" };

/**
 * Creates a sandbox endpoint through create_sandbox_endpoint(), which checks
 * the registration, its endpoint cap and the pool under one lock. A slug
 * collision comes back as a unique violation and is retried with a new slug.
 */
export async function createSandboxEndpoint(
  registrationId: string,
  limits: { maxEndpoints: number; poolSize: number }
): Promise<CreateSandboxEndpointResult> {
  const admin = createAdminClient();
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const { data, error } = await admin.rpc("create_sandbox_endpoint", {
      p_registration_id: registrationId,
      p_slug: nanoidSlug(),
      p_max_endpoints: limits.maxEndpoints,
      p_pool_size: limits.poolSize,
    });
    if (error) {
      if (error.code === "23505") continue;
      throw error;
    }
    const result = data as { status: string; id?: string };
    if (result.status === "ok" && result.id) {
      const { data: row, error: readError } = await admin
        .from("endpoints")
        .select(SANDBOX_ENDPOINT_COLUMNS)
        .eq("id", result.id)
        .returns<SandboxEndpointRow>()
        .single();
      if (readError) throw readError;
      return { status: "ok", endpoint: normalizeSandboxEndpoint(row) };
    }
    if (
      result.status === "registration_inactive" ||
      result.status === "endpoint_limit" ||
      result.status === "pool_full"
    ) {
      return { status: result.status };
    }
    throw new Error(`Unexpected create_sandbox_endpoint status: ${result.status}`);
  }
  throw new Error("Failed to generate unique slug");
}

/** Live sandbox endpoints in the pool, across all registrations. */
export async function countLiveSandboxEndpoints(): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("endpoints")
    .select("id", { count: "exact", head: true })
    .not("agent_registration_id", "is", null)
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  return count ?? 0;
}

export async function listSandboxEndpoints(
  registrationId: string
): Promise<SandboxEndpointRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select(SANDBOX_ENDPOINT_COLUMNS)
    .eq("agent_registration_id", registrationId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .returns<SandboxEndpointRow[]>();
  if (error) throw error;
  return (data ?? []).map(normalizeSandboxEndpoint);
}

export async function getSandboxEndpointBySlug(
  registrationId: string,
  slug: string
): Promise<SandboxEndpointRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select(SANDBOX_ENDPOINT_COLUMNS)
    .eq("agent_registration_id", registrationId)
    .eq("slug", slug.toLowerCase())
    .gt("expires_at", new Date().toISOString())
    .returns<SandboxEndpointRow>()
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeSandboxEndpoint(data) : null;
}

/** Frees the pool slot; its captures go with it. */
export async function deleteSandboxEndpointBySlug(
  registrationId: string,
  slug: string
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .delete()
    .eq("agent_registration_id", registrationId)
    .eq("slug", slug.toLowerCase())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** The longest retention an endpoint may have (its billing account's), or null when it does not exist. */
export async function endpointRetentionCap(slug: string): Promise<number | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoints")
    .select("retention_cap")
    .eq("slug", slug.toLowerCase())
    .maybeSingle<{ retention_cap: number | null }>();
  if (error) throw error;
  return data?.retention_cap ?? null;
}
