import { describe, it, expect } from "vitest";
import {
  parseJsonBody,
  parseFormBody,
  parseBody,
  extractJsonField,
  detectWebhookInfo,
  detectWebhookProvider,
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
  isTwilioWebhook,
  isPaddleWebhook,
  isLinearWebhook,
  isDiscordWebhook,
  isSendGridWebhook,
  isClerkWebhook,
  isVercelWebhook,
  isGitLabWebhook,
  isTypeformWebhook,
  isStandardWebhook,
  isMetaWebhook,
  isLemonSqueezyWebhook,
  isCoinbaseCommerceWebhook,
  isRazorpayWebhook,
  isCalWebhook,
  isIntercomWebhook,
  isTelegramWebhook,
  isSquareWebhook,
  isHubSpotWebhook,
  isMailgunWebhook,
  isCalendlyWebhook,
  isMuxWebhook,
  isSentryWebhook,
  isBitbucketWebhook,
} from "../helpers";
import type { Request } from "../types";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: "r1",
    endpointId: "ep1",
    method: "POST",
    path: "/",
    headers: {},
    queryParams: {},
    ip: "127.0.0.1",
    size: 0,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("parseJsonBody", () => {
  it("parses valid JSON body", () => {
    expect(parseJsonBody(makeRequest({ body: '{"key":"value"}' }))).toEqual({ key: "value" });
  });

  it("returns undefined for empty body", () => {
    expect(parseJsonBody(makeRequest({ body: undefined }))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseJsonBody(makeRequest({ body: "not json" }))).toBeUndefined();
  });
});

describe("parseFormBody", () => {
  it("parses urlencoded bodies", () => {
    expect(
      parseFormBody(
        makeRequest({
          body: "foo=bar&foo=baz&hello=world",
          contentType: "application/x-www-form-urlencoded",
        })
      )
    ).toEqual({
      foo: ["bar", "baz"],
      hello: "world",
    });
  });

  it("returns undefined for non-form content types", () => {
    expect(
      parseFormBody(
        makeRequest({
          body: '{"foo":"bar"}',
          contentType: "application/json",
        })
      )
    ).toBeUndefined();
  });
});

describe("parseBody", () => {
  it("parses JSON when content-type is application/json", () => {
    expect(
      parseBody(
        makeRequest({
          body: '{"foo":{"bar":42}}',
          contentType: "application/json; charset=utf-8",
        })
      )
    ).toEqual({ foo: { bar: 42 } });
  });

  it("parses form data when content-type is urlencoded", () => {
    expect(
      parseBody(
        makeRequest({
          body: "foo=bar&baz=qux",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
      )
    ).toEqual({ foo: "bar", baz: "qux" });
  });

  it("returns raw text for unsupported content types", () => {
    expect(
      parseBody(
        makeRequest({
          body: "<xml />",
          contentType: "application/xml",
        })
      )
    ).toBe("<xml />");
  });
});

describe("extractJsonField", () => {
  it("extracts nested JSON values using dot notation", () => {
    expect(
      extractJsonField<number>(
        makeRequest({
          body: '{"data":{"object":{"amount":4999}}}',
          contentType: "application/json",
        }),
        "data.object.amount"
      )
    ).toBe(4999);
  });

  it("supports array indexing and returns undefined for missing paths", () => {
    expect(
      extractJsonField<string>(
        makeRequest({
          body: '{"items":[{"id":"a"},{"id":"b"}]}',
          contentType: "application/json",
        }),
        "items.1.id"
      )
    ).toBe("b");
    expect(extractJsonField(makeRequest({ body: '{"items":[]}' }), "items.0.id")).toBeUndefined();
  });
});

describe("isStripeWebhook", () => {
  it("detects stripe-signature header", () => {
    expect(isStripeWebhook(makeRequest({ headers: { "stripe-signature": "t=1234" } }))).toBe(true);
  });

  it("detects case-insensitive", () => {
    expect(isStripeWebhook(makeRequest({ headers: { "Stripe-Signature": "t=1234" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isStripeWebhook(makeRequest())).toBe(false);
  });
});

describe("isGitHubWebhook", () => {
  it("detects x-github-event header", () => {
    expect(isGitHubWebhook(makeRequest({ headers: { "x-github-event": "push" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isGitHubWebhook(makeRequest())).toBe(false);
  });
});

describe("isShopifyWebhook", () => {
  it("detects x-shopify-hmac-sha256 header", () => {
    expect(isShopifyWebhook(makeRequest({ headers: { "x-shopify-hmac-sha256": "abc" } }))).toBe(
      true
    );
  });

  it("is case-insensitive", () => {
    expect(isShopifyWebhook(makeRequest({ headers: { "X-Shopify-Hmac-Sha256": "abc" } }))).toBe(
      true
    );
  });

  it("returns false without header", () => {
    expect(isShopifyWebhook(makeRequest())).toBe(false);
  });
});

describe("isSlackWebhook", () => {
  it("detects x-slack-signature header", () => {
    expect(isSlackWebhook(makeRequest({ headers: { "x-slack-signature": "v0=abc" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isSlackWebhook(makeRequest())).toBe(false);
  });
});

describe("isTwilioWebhook", () => {
  it("detects x-twilio-signature header", () => {
    expect(isTwilioWebhook(makeRequest({ headers: { "x-twilio-signature": "abc" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isTwilioWebhook(makeRequest())).toBe(false);
  });
});

describe("isPaddleWebhook", () => {
  it("detects paddle-signature header", () => {
    expect(isPaddleWebhook(makeRequest({ headers: { "paddle-signature": "ts=123" } }))).toBe(true);
  });

  it("returns false without header", () => {
    expect(isPaddleWebhook(makeRequest())).toBe(false);
  });
});

describe("isLinearWebhook", () => {
  it("detects linear-signature header", () => {
    expect(isLinearWebhook(makeRequest({ headers: { "linear-signature": "sha256=abc" } }))).toBe(
      true
    );
  });

  it("returns false without header", () => {
    expect(isLinearWebhook(makeRequest())).toBe(false);
  });
});

describe("isDiscordWebhook", () => {
  it("detects both Discord signature headers", () => {
    expect(
      isDiscordWebhook(
        makeRequest({
          headers: {
            "x-signature-ed25519": "deadbeef",
            "x-signature-timestamp": "1700000000",
          },
        })
      )
    ).toBe(true);
  });

  it("returns false when either Discord header is missing", () => {
    expect(
      isDiscordWebhook(
        makeRequest({
          headers: {
            "x-signature-ed25519": "deadbeef",
          },
        })
      )
    ).toBe(false);
  });
});

describe("isSendGridWebhook", () => {
  it("returns true when body is a JSON array with sg_event_id field", () => {
    expect(
      isSendGridWebhook(
        makeRequest({
          body: '[{"sg_event_id":"abc123","event":"delivered","email":"test@example.com"}]',
        })
      )
    ).toBe(true);
  });

  it("returns false when body is a regular JSON object", () => {
    expect(
      isSendGridWebhook(
        makeRequest({
          body: '{"sg_event_id":"abc123","event":"delivered"}',
        })
      )
    ).toBe(false);
  });

  it("returns false when body is empty", () => {
    expect(isSendGridWebhook(makeRequest())).toBe(false);
  });
});

describe("isClerkWebhook", () => {
  it("returns true when svix-id header is present", () => {
    expect(isClerkWebhook(makeRequest({ headers: { "svix-id": "msg_abc123" } }))).toBe(true);
  });

  it("returns false without svix-id header", () => {
    expect(isClerkWebhook(makeRequest())).toBe(false);
  });
});

describe("isVercelWebhook", () => {
  it("returns true when x-vercel-signature header is present", () => {
    expect(isVercelWebhook(makeRequest({ headers: { "x-vercel-signature": "abc123" } }))).toBe(
      true
    );
  });

  it("returns false without x-vercel-signature header", () => {
    expect(isVercelWebhook(makeRequest())).toBe(false);
  });
});

describe("isGitLabWebhook", () => {
  it("returns true when x-gitlab-event header is present", () => {
    expect(isGitLabWebhook(makeRequest({ headers: { "x-gitlab-event": "Push Hook" } }))).toBe(true);
  });

  it("returns true when x-gitlab-token header is present", () => {
    expect(isGitLabWebhook(makeRequest({ headers: { "x-gitlab-token": "my-secret-token" } }))).toBe(
      true
    );
  });

  it("returns false without either header", () => {
    expect(isGitLabWebhook(makeRequest())).toBe(false);
  });
});

describe("isTypeformWebhook", () => {
  it("returns true when typeform-signature header is present", () => {
    expect(
      isTypeformWebhook(makeRequest({ headers: { "typeform-signature": "sha256=abc123" } }))
    ).toBe(true);
  });

  it("returns false without typeform-signature header", () => {
    expect(isTypeformWebhook(makeRequest())).toBe(false);
  });
});

describe("isStandardWebhook", () => {
  it("detects all three Standard Webhooks headers", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "webhook-id": "msg_123",
            "webhook-timestamp": "1700000000",
            "webhook-signature": "v1,abc123",
          },
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "Webhook-Id": "msg_123",
            "Webhook-Timestamp": "1700000000",
            "Webhook-Signature": "v1,abc123",
          },
        })
      )
    ).toBe(true);
  });

  it("returns false when only some headers present", () => {
    expect(
      isStandardWebhook(
        makeRequest({
          headers: {
            "webhook-id": "msg_123",
            "webhook-timestamp": "1700000000",
          },
        })
      )
    ).toBe(false);
  });

  it("returns false without headers", () => {
    expect(isStandardWebhook(makeRequest())).toBe(false);
  });
});

describe("isSquareWebhook", () => {
  it("detects Square by the x-square-hmacsha256-signature header", () => {
    expect(
      isSquareWebhook(
        makeRequest({
          headers: { "x-square-hmacsha256-signature": "abc123" },
          body: JSON.stringify({ type: "payment.created" }),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(
      isSquareWebhook(makeRequest({ headers: { "X-Square-HmacSha256-Signature": "abc123" } }))
    ).toBe(true);
  });

  it("returns false without the header", () => {
    expect(isSquareWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event type from the body via detectWebhookInfo", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "x-square-hmacsha256-signature": "abc123" },
        body: JSON.stringify({ type: "payment.updated" }),
      })
    );
    expect(info?.provider).toBe("square");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("x-square-hmacsha256-signature");
    expect(info?.event).toBe("payment.updated");
  });
});

describe("isHubSpotWebhook", () => {
  it("detects HubSpot by the x-hubspot-signature-v3 header", () => {
    expect(
      isHubSpotWebhook(
        makeRequest({
          headers: { "x-hubspot-signature-v3": "abc123" },
          body: JSON.stringify([{ subscriptionType: "contact.creation" }]),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(isHubSpotWebhook(makeRequest({ headers: { "X-HubSpot-Signature-V3": "abc123" } }))).toBe(
      true
    );
  });

  it("returns false without the header", () => {
    expect(isHubSpotWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event type from the first array element's subscriptionType", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "x-hubspot-signature-v3": "abc123" },
        body: JSON.stringify([{ subscriptionType: "deal.creation", objectId: 1 }]),
      })
    );
    expect(info?.provider).toBe("hubspot");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("x-hubspot-signature-v3");
    expect(info?.event).toBe("deal.creation");
  });
});

describe("isMailgunWebhook", () => {
  it("detects Mailgun by the body signature fields (no signature header)", () => {
    expect(
      isMailgunWebhook(
        makeRequest({
          body: JSON.stringify({
            signature: { timestamp: "1700000000", token: "abc", signature: "deadbeef" },
            "event-data": { event: "delivered" },
          }),
        })
      )
    ).toBe(true);
  });

  it("returns false when the body lacks both signature.token and signature.timestamp", () => {
    expect(isMailgunWebhook(makeRequest({ body: JSON.stringify({ "event-data": {} }) }))).toBe(
      false
    );
    // Only one of the two required fields present → not detected.
    expect(
      isMailgunWebhook(makeRequest({ body: JSON.stringify({ signature: { token: "abc" } }) }))
    ).toBe(false);
  });

  it("does not throw on non-JSON bodies", () => {
    expect(isMailgunWebhook(makeRequest({ body: "not json" }))).toBe(false);
    expect(isMailgunWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event type from event-data.event via detectWebhookInfo", () => {
    const info = detectWebhookInfo(
      makeRequest({
        body: JSON.stringify({
          signature: { timestamp: "1700000000", token: "abc", signature: "deadbeef" },
          "event-data": { event: "failed" },
        }),
      })
    );
    expect(info?.provider).toBe("mailgun");
    expect(info?.via).toBe("body");
    expect(info?.event).toBe("failed");
  });
});

describe("isCalendlyWebhook", () => {
  it("detects Calendly by the calendly-webhook-signature header", () => {
    expect(
      isCalendlyWebhook(
        makeRequest({
          headers: { "calendly-webhook-signature": "t=1700000000,v1=deadbeef" },
          body: JSON.stringify({ event: "invitee.created" }),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(
      isCalendlyWebhook(makeRequest({ headers: { "Calendly-Webhook-Signature": "t=1,v1=ab" } }))
    ).toBe(true);
  });

  it("returns false without the header", () => {
    expect(isCalendlyWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event type from the body event field via detectWebhookInfo", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "calendly-webhook-signature": "t=1700000000,v1=deadbeef" },
        body: JSON.stringify({ event: "invitee.canceled" }),
      })
    );
    expect(info?.provider).toBe("calendly");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("calendly-webhook-signature");
    expect(info?.event).toBe("invitee.canceled");
  });
});

describe("isMuxWebhook", () => {
  it("detects Mux by the mux-signature header", () => {
    expect(
      isMuxWebhook(
        makeRequest({
          headers: { "mux-signature": "t=1700000000,v1=deadbeef" },
          body: JSON.stringify({ type: "video.asset.created" }),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(isMuxWebhook(makeRequest({ headers: { "Mux-Signature": "t=1,v1=ab" } }))).toBe(true);
  });

  it("returns false without the header", () => {
    expect(isMuxWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event type from the body type field via detectWebhookInfo", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "mux-signature": "t=1700000000,v1=deadbeef" },
        body: JSON.stringify({ type: "video.asset.ready" }),
      })
    );
    expect(info?.provider).toBe("mux");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("mux-signature");
    expect(info?.event).toBe("video.asset.ready");
  });
});

describe("isSentryWebhook", () => {
  it("detects Sentry by the sentry-hook-signature header", () => {
    expect(
      isSentryWebhook(
        makeRequest({
          headers: { "sentry-hook-signature": "deadbeef", "sentry-hook-resource": "issue" },
          body: JSON.stringify({ action: "created" }),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(isSentryWebhook(makeRequest({ headers: { "Sentry-Hook-Signature": "abc123" } }))).toBe(
      true
    );
  });

  it("returns false without the header", () => {
    expect(isSentryWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event resource from the sentry-hook-resource header", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "sentry-hook-signature": "deadbeef", "sentry-hook-resource": "issue" },
        body: JSON.stringify({ action: "created" }),
      })
    );
    expect(info?.provider).toBe("sentry");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("sentry-hook-signature");
    expect(info?.event).toBe("issue");
  });
});

describe("isBitbucketWebhook", () => {
  it("detects Bitbucket by the x-event-key header", () => {
    expect(
      isBitbucketWebhook(
        makeRequest({
          headers: { "x-event-key": "repo:push", "x-hub-signature": "sha256=deadbeef" },
          body: JSON.stringify({ push: { changes: [] } }),
        })
      )
    ).toBe(true);
  });

  it("is case-insensitive on the header", () => {
    expect(
      isBitbucketWebhook(makeRequest({ headers: { "X-Event-Key": "pullrequest:created" } }))
    ).toBe(true);
  });

  it("returns false without the x-event-key header", () => {
    expect(isBitbucketWebhook(makeRequest())).toBe(false);
  });

  it("extracts the event from the x-event-key header", () => {
    const info = detectWebhookInfo(
      makeRequest({
        headers: { "x-event-key": "repo:push", "x-hub-signature": "sha256=deadbeef" },
        body: JSON.stringify({ push: { changes: [] } }),
      })
    );
    expect(info?.provider).toBe("bitbucket");
    expect(info?.via).toBe("header");
    expect(info?.matchedOn).toBe("x-event-key");
    expect(info?.event).toBe("repo:push");
  });
});

describe("detectWebhookProvider", () => {
  it("returns null when no provider matches", () => {
    expect(detectWebhookProvider(makeRequest())).toBeNull();
  });

  it("prefers clerk over generic standard-webhooks detection", () => {
    expect(
      detectWebhookProvider(
        makeRequest({
          headers: {
            "svix-id": "msg_123",
            "svix-timestamp": "1700000000",
            "svix-signature": "v1,abc",
            "webhook-id": "msg_123",
            "webhook-timestamp": "1700000000",
            "webhook-signature": "v1,abc",
          },
        })
      )
    ).toBe("clerk");
  });

  it("detects github from the signature header even if the event header is missing", () => {
    expect(
      detectWebhookProvider(
        makeRequest({
          headers: {
            "x-hub-signature-256": "sha256=abc123",
          },
        })
      )
    ).toBe("github");
  });

  it("detects sendgrid from the request body", () => {
    expect(
      detectWebhookProvider(
        makeRequest({
          body: '[{"sg_event_id":"abc123","event":"delivered","email":"test@example.com"}]',
        })
      )
    ).toBe("sendgrid");
  });
});

describe("detectWebhookInfo", () => {
  it("extracts header-based event names", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          headers: {
            "x-github-event": "pull_request",
          },
          body: '{"action":"opened"}',
        })
      )
    ).toEqual({
      provider: "github",
      event: "pull_request",
      via: "header",
      matchedOn: "x-github-event",
    });
  });

  it("extracts body-based event names", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          headers: {
            "stripe-signature": "t=123,v1=abc",
          },
          body: '{"type":"checkout.session.completed"}',
        })
      )
    ).toEqual({
      provider: "stripe",
      event: "checkout.session.completed",
      via: "header",
      matchedOn: "stripe-signature",
    });
  });

  it("normalizes gitlab hook names into event identifiers", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          headers: {
            "x-gitlab-event": "Merge Request Hook",
            "x-gitlab-token": "secret",
          },
        })
      )
    ).toEqual({
      provider: "gitlab",
      event: "merge_request",
      via: "header",
      matchedOn: "x-gitlab-event",
    });
  });

  it("extracts sendgrid event names from the first body item", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          body: '[{"sg_event_id":"abc123","event":"bounce","email":"test@example.com"}]',
        })
      )
    ).toEqual({
      provider: "sendgrid",
      event: "bounce",
      via: "body",
      matchedOn: "body[].sg_event_id",
    });
  });

  it("extracts Typeform event names from the request body", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          headers: {
            "typeform-signature": "sha256=abc123",
          },
          body: '{"event_type":"form_response","form_response":{"token":"abc"}}',
        })
      )
    ).toEqual({
      provider: "typeform",
      event: "form_response",
      via: "header",
      matchedOn: "typeform-signature",
    });
  });

  it("returns null when no provider matches", () => {
    expect(
      detectWebhookInfo(
        makeRequest({
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        })
      )
    ).toBeNull();
  });
});

describe("tier-1 provider detection", () => {
  it("detects Meta webhooks from body object + entry, not as GitHub", () => {
    const req = makeRequest({
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] }),
      contentType: "application/json",
    });
    expect(detectWebhookProvider(req)).toBe("meta");
    expect(isMetaWebhook(req)).toBe(true);
  });

  it("detects Meta page and instagram objects", () => {
    expect(
      detectWebhookProvider(makeRequest({ body: JSON.stringify({ object: "page", entry: [{}] }) }))
    ).toBe("meta");
    expect(
      detectWebhookProvider(
        makeRequest({ body: JSON.stringify({ object: "instagram", entry: [{}] }) })
      )
    ).toBe("meta");
  });

  it("does not treat a GitHub-shaped body as Meta (falls back to github)", () => {
    const req = makeRequest({
      headers: { "x-hub-signature-256": "sha256=abc" },
      body: JSON.stringify({ ref: "refs/heads/main", repository: {} }),
    });
    expect(detectWebhookProvider(req)).toBe("github");
  });

  it("detects Lemon Squeezy from body.meta.event_name", () => {
    const req = makeRequest({
      headers: { "x-signature": "abc" },
      body: JSON.stringify({ meta: { event_name: "order_created" }, data: {} }),
    });
    expect(detectWebhookProvider(req)).toBe("lemonsqueezy");
    expect(isLemonSqueezyWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("order_created");
  });

  it("detects Coinbase Commerce from x-cc-webhook-signature + event.type", () => {
    const req = makeRequest({
      headers: { "x-cc-webhook-signature": "abc" },
      body: '{"event":{"type":"charge:confirmed"}}',
    });
    expect(detectWebhookProvider(req)).toBe("coinbase-commerce");
    expect(isCoinbaseCommerceWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("charge:confirmed");
  });

  it("detects Razorpay from x-razorpay-signature + event", () => {
    const req = makeRequest({
      headers: { "x-razorpay-signature": "abc" },
      body: '{"event":"payment.captured"}',
    });
    expect(detectWebhookProvider(req)).toBe("razorpay");
    expect(isRazorpayWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("payment.captured");
  });

  it("detects Cal.com from x-cal-signature-256 + triggerEvent", () => {
    const req = makeRequest({
      headers: { "x-cal-signature-256": "abc" },
      body: '{"triggerEvent":"BOOKING_CREATED"}',
    });
    expect(detectWebhookProvider(req)).toBe("cal");
    expect(isCalWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("BOOKING_CREATED");
  });

  it("detects Intercom from sha1= x-hub-signature + topic", () => {
    const req = makeRequest({
      headers: { "x-hub-signature": "sha1=deadbeef" },
      body: '{"type":"notification_event","topic":"conversation.user.created"}',
    });
    expect(detectWebhookProvider(req)).toBe("intercom");
    expect(isIntercomWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("conversation.user.created");
  });

  it("detects Telegram from x-telegram-bot-api-secret-token", () => {
    const req = makeRequest({
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      body: '{"update_id":1,"message":{"text":"hi"}}',
    });
    expect(detectWebhookProvider(req)).toBe("telegram");
    expect(isTelegramWebhook(req)).toBe(true);
  });

  it("detects Bitbucket from x-event-key + sha256= x-hub-signature", () => {
    const req = makeRequest({
      headers: { "x-event-key": "repo:push", "x-hub-signature": "sha256=deadbeef" },
      body: '{"push":{"changes":[]}}',
    });
    expect(detectWebhookProvider(req)).toBe("bitbucket");
    expect(isBitbucketWebhook(req)).toBe(true);
    expect(detectWebhookInfo(req)?.event).toBe("repo:push");
  });

  // ── x-hub-signature collision regression: Bitbucket (sha256=) vs Intercom (sha1=) ──

  it("Bitbucket (x-event-key + sha256=) detects bitbucket, not intercom", () => {
    // Both providers send x-hub-signature; Bitbucket's unique x-event-key + the
    // bitbucket-before-intercom ordering must win.
    const req = makeRequest({
      headers: {
        "x-event-key": "repo:push",
        "x-hub-signature": "sha256=cafef00d",
      },
      body: JSON.stringify({ push: { changes: [] } }),
    });
    expect(detectWebhookProvider(req)).toBe("bitbucket");
    expect(isBitbucketWebhook(req)).toBe(true);
    expect(isIntercomWebhook(req)).toBe(false);
  });

  it("Intercom (sha1=, no x-event-key) detects intercom, not bitbucket", () => {
    const req = makeRequest({
      headers: { "x-hub-signature": "sha1=deadbeef" },
      body: '{"type":"notification_event","topic":"conversation.user.created"}',
    });
    expect(detectWebhookProvider(req)).toBe("intercom");
    expect(isIntercomWebhook(req)).toBe(true);
    expect(isBitbucketWebhook(req)).toBe(false);
  });

  // ── Ordering regressions: tier-1 additions must not break existing providers ──

  it("a real GitHub push (with legacy sha1 x-hub-signature) still detects as github, not intercom", () => {
    const req = makeRequest({
      headers: {
        "x-github-event": "push",
        "x-hub-signature": "sha1=deadbeef",
        "x-hub-signature-256": "sha256=cafef00d",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(detectWebhookProvider(req)).toBe("github");
  });

  it("Intercom (sha1=) stays intercom and does not collide with GitHub", () => {
    expect(
      detectWebhookProvider(makeRequest({ headers: { "x-hub-signature": "sha1=abc" }, body: "{}" }))
    ).toBe("intercom");
  });

  it("does not classify a Telegram request as Intercom even if the body has type=notification_event", () => {
    // Intercom detection requires its x-hub-signature header; a body field
    // alone must not shadow Telegram (which carries no x-hub-signature).
    const req = makeRequest({
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      body: '{"type":"notification_event","update_id":1}',
    });
    expect(detectWebhookProvider(req)).toBe("telegram");
  });

  it("does not classify a header-less notification_event body as Intercom", () => {
    expect(
      detectWebhookProvider(makeRequest({ body: '{"type":"notification_event"}' }))
    ).toBeNull();
  });

  it("no tier-1 body shape mis-detects as standard-webhooks", () => {
    const bodies = [
      JSON.stringify({ object: "whatsapp_business_account", entry: [{}] }),
      JSON.stringify({ meta: { event_name: "order_created" } }),
      '{"event":{"type":"charge:confirmed"}}',
    ];
    for (const body of bodies) {
      expect(detectWebhookProvider(makeRequest({ body }))).not.toBe("standard-webhooks");
    }
  });
});
