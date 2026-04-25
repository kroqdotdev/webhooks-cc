import { describe, expect, test } from "vitest";

import { deriveWebhookDetection } from "./webhook-detection";

describe("deriveWebhookDetection", () => {
  test("derives header-based provider and body-based event metadata", () => {
    expect(
      deriveWebhookDetection({
        headers: {
          "stripe-signature": "t=1700000000,v1=abc123",
          "content-type": "application/json",
        },
        body: '{"type":"checkout.session.completed"}',
      })
    ).toEqual({
      detectedProvider: "stripe",
      detectedEvent: "checkout.session.completed",
    });
  });

  test("derives body-based SendGrid detection", () => {
    expect(
      deriveWebhookDetection({
        headers: {
          "content-type": "application/json",
        },
        body: '[{"email":"dev@example.com","event":"delivered","sg_event_id":"evt_123"}]',
      })
    ).toEqual({
      detectedProvider: "sendgrid",
      detectedEvent: "delivered",
    });
  });

  test("derives Typeform signature and event metadata", () => {
    expect(
      deriveWebhookDetection({
        headers: {
          "typeform-signature": "sha256=abc123",
          "content-type": "application/json",
        },
        body: '{"event_type":"form_response","form_response":{"form_id":"abc123"}}',
      })
    ).toEqual({
      detectedProvider: "typeform",
      detectedEvent: "form_response",
    });
  });

  test("returns null metadata when no provider matches", () => {
    expect(
      deriveWebhookDetection({
        headers: {
          "content-type": "application/json",
        },
        body: '{"ok":true}',
      })
    ).toEqual({
      detectedProvider: null,
      detectedEvent: null,
    });
  });
});
