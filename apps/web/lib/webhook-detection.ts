import { detectWebhookInfo } from "@webhooks-cc/sdk";

export interface DetectedWebhookFields {
  detectedProvider: string | null;
  detectedEvent: string | null;
}

export function deriveWebhookDetection(input: {
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
}): DetectedWebhookFields {
  const detected = detectWebhookInfo({
    headers: input.headers,
    body: input.body,
    contentType: input.contentType,
  });

  return {
    detectedProvider: detected?.provider ?? null,
    detectedEvent: detected?.event ?? null,
  };
}
