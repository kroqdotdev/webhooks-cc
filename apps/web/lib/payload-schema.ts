import {
  generateRequestSchema,
  payloadSample,
  type PayloadSchemaFormat,
  type RequestSchemaResult,
} from "@webhooks-cc/sdk/schema";

export type { PayloadSchemaFormat };

export const SCHEMA_FORMATS: { value: PayloadSchemaFormat; label: string }[] = [
  { value: "typescript", label: "TypeScript" },
  { value: "zod", label: "Zod" },
  { value: "pydantic", label: "Pydantic" },
  { value: "json-schema", label: "JSON Schema" },
];

export const SCHEMA_FORMAT_STORAGE_KEY = "whk:schema-format";

/** The request fields schema grouping and generation read. */
export interface SchemaSource {
  _id?: string;
  id?: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
  kind?: "http" | "email";
  detectedProvider?: string | null;
  detectedEvent?: string | null;
}

export function isSchemaFormat(value: unknown): value is PayloadSchemaFormat {
  return SCHEMA_FORMATS.some((format) => format.value === value);
}

/** True when the request has a JSON or form body to learn a schema from. */
export function hasSchemaSample(request: SchemaSource): boolean {
  return payloadSample(request) !== undefined;
}

/**
 * Requests that carry the same kind of payload: the same detected provider
 * event, or without one, the same method and path.
 */
export function schemaGroupKey(request: SchemaSource): string {
  if (request.detectedEvent) {
    return `event:${request.detectedProvider ?? ""}:${request.detectedEvent}`;
  }
  return `route:${request.method} ${request.path}`;
}

/** How the group is described: "stripe invoice.paid" or "POST /webhooks". */
export function schemaGroupLabel(request: SchemaSource): string {
  if (request.detectedEvent) {
    return [request.detectedProvider, request.detectedEvent].filter(Boolean).join(" ");
  }
  return `${request.method} ${request.path}`;
}

/** "invoice.paid" becomes InvoicePaidEvent; without an event, WebhookPayload. */
export function schemaRootName(request: SchemaSource): string {
  const words = (request.detectedEvent ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "WebhookPayload";
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return /^[0-9]/.test(name) ? `Webhook${name}Event` : `${name}Event`;
}

function requestId(request: SchemaSource): string | undefined {
  return request._id ?? request.id;
}

/** The candidates in the request's group that have a usable body, the request first. */
export function similarSchemaRequests(
  request: SchemaSource,
  candidates: SchemaSource[]
): SchemaSource[] {
  const key = schemaGroupKey(request);
  const id = requestId(request);
  const peers = candidates.filter(
    (candidate) =>
      requestId(candidate) !== id &&
      candidate.kind !== "email" &&
      schemaGroupKey(candidate) === key &&
      hasSchemaSample(candidate)
  );
  return [request, ...peers];
}

export function buildPayloadSchema(
  requests: SchemaSource[],
  format: PayloadSchemaFormat,
  name: string
): RequestSchemaResult {
  return generateRequestSchema(requests, { format, name });
}
