package templates

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"webhooks.cc/go/internal/jsonx"
)

// o builds an ordered object from alternating keys and values.
func o(pairs ...any) jsonx.Object {
	if len(pairs)%2 != 0 {
		panic("templates: o needs key and value pairs")
	}
	object := make(jsonx.Object, 0, len(pairs)/2)
	for i := 0; i < len(pairs); i += 2 {
		object = append(object, jsonx.Member{Key: pairs[i].(string), Value: pairs[i+1]})
	}
	return object
}

// with returns a copy of base with the pairs set, as {...base, key: value}.
func with(base jsonx.Object, pairs ...any) jsonx.Object {
	out := append(jsonx.Object{}, base...)
	for _, member := range o(pairs...) {
		out.Set(member.Key, member.Value)
	}
	return out
}

type list = []any

type payloadContext struct {
	provider string
	template string
	event    string
	nowSec   int64
	nowISO   string
	body     override
}

type built struct {
	body         string
	contentType  string
	headers      map[string]string
	twilioParams [][2]string
}

func (c payloadContext) json(sample any, headers map[string]string) (built, error) {
	body, err := c.body.payload(sample)
	if err != nil {
		return built{}, err
	}
	if headers == nil {
		headers = map[string]string{}
	}
	return built{body: body, contentType: contentJSON, headers: headers}, nil
}

func userAgent(value string) map[string]string { return map[string]string{"user-agent": value} }

func buildPayload(c payloadContext) (built, error) {
	switch c.provider {
	case "stripe":
		return c.json(stripePayload(c), userAgent("Stripe/1.0 (+https://stripe.com/docs/webhooks)"))
	case "github":
		return c.json(githubPayload(c), userAgent("GitHub-Hookshot/8f03f6d"))
	case "shopify":
		return c.json(shopifyPayload(c), map[string]string{
			"x-shopify-shop-domain":  "demo-shop.myshopify.com",
			"x-shopify-api-version":  "2025-10",
			"x-shopify-webhook-id":   randomUUID(),
			"x-shopify-event-id":     randomUUID(),
			"x-shopify-triggered-at": c.nowISO,
		})
	case "meta":
		return c.json(metaPayload(c), userAgent("facebookplatform/1.0 (+http://www.facebook.com/platform)"))
	case "lemonsqueezy":
		return c.json(lemonSqueezyPayload(c), userAgent("Lemon Squeezy Webhooks"))
	case "coinbase-commerce":
		return c.json(coinbasePayload(c), userAgent("weipay-webhooks"))
	case "razorpay":
		return c.json(razorpayPayload(c), userAgent("Razorpay-Webhook/1.0"))
	case "cal":
		return c.json(calPayload(c), userAgent("Cal.com Webhook"))
	case "intercom":
		return c.json(intercomPayload(c), userAgent("Intercom-Webhook/1.1"))
	case "telegram":
		return c.json(telegramPayload(c), nil)
	case "square":
		return c.json(squarePayload(c), userAgent("Square-Webhooks/1.0"))
	case "hubspot":
		return c.json(hubspotPayload(c), userAgent("HubSpot-Webhooks/1.0"))
	case "mailgun":
		return c.json(mailgunPayload(c), userAgent("Mailgun-Webhooks/1.0"))
	case "calendly":
		return c.json(calendlyPayload(c), userAgent("Calendly-Webhooks/1.0"))
	case "mux":
		return c.json(muxPayload(c), userAgent("Mux-Webhooks/1.0"))
	case "resend":
		return c.json(resendPayload(c), userAgent("Svix-Webhooks/1.0"))
	case "workos":
		return c.json(workosPayload(c), nil)
	case "sentry":
		return c.json(sentryPayload(c), userAgent("Sentry-Webhooks/1.0"))
	case "bitbucket":
		return c.json(bitbucketPayload(c), userAgent("Bitbucket-Webhooks/1.0"))
	case "docusign":
		return c.json(docusignPayload(c), userAgent("DocuSign Connect"))
	case "adyen":
		return c.json(adyenPayload(c), userAgent("Adyen-Webhooks/1.0"))
	case "paypal":
		return c.json(paypalPayload(c), userAgent("PayPal/AUHD-214.0-56782998"))
	case "slack":
		return slackPayload(c)
	case "paddle":
		return c.json(paddlePayload(c), userAgent("Paddle/1.0"))
	case "linear":
		return c.json(linearPayload(c), userAgent("Linear/1.0"))
	case "clerk":
		return c.json(clerkPayload(c), userAgent("Svix-Webhooks/1.0"))
	case "vercel":
		return c.json(vercelPayload(c), userAgent("Vercel/1.0"))
	case "gitlab":
		event := "Push Hook"
		if c.template == "merge_request" {
			event = "Merge Request Hook"
		}
		return c.json(gitlabPayload(c), map[string]string{"x-gitlab-event": event, "user-agent": "GitLab/1.0"})
	case "typeform":
		return c.json(typeformPayload(c), userAgent("Typeform Webhooks"))
	case "twilio":
		return twilioPayload(c)
	}
	return built{}, fmt.Errorf("unsupported provider %q", c.provider)
}

func stripePayload(c payloadContext) any {
	paymentIntentID := randomToken("pi")
	envelope := func(object jsonx.Object) jsonx.Object {
		return o(
			"id", randomToken("evt"),
			"object", "event",
			"api_version", "2025-01-27.acacia",
			"created", c.nowSec,
			"data", o("object", object),
			"livemode", false,
			"pending_webhooks", 1,
			"request", o("id", "req_"+randomHex(24), "idempotency_key", nil),
			"type", c.event,
		)
	}
	switch c.template {
	case "payment_intent.succeeded":
		return envelope(o(
			"id", paymentIntentID,
			"object", "payment_intent",
			"amount", 2000,
			"amount_received", 2000,
			"currency", "usd",
			"status", "succeeded",
			"created", c.nowSec,
			"metadata", o("order_id", randomToken("order")),
		))
	case "checkout.session.completed":
		return envelope(o(
			"id", "cs_test_"+randomHex(24),
			"object", "checkout.session",
			"mode", "payment",
			"payment_status", "paid",
			"amount_total", 2000,
			"amount_subtotal", 2000,
			"currency", "usd",
			"customer", "cus_"+randomHex(14),
			"payment_intent", paymentIntentID,
			"status", "complete",
			"success_url", "https://example.com/success",
			"cancel_url", "https://example.com/cancel",
			"created", c.nowSec,
		))
	case "invoice.paid":
		return envelope(o(
			"id", "in_"+randomHex(14),
			"object", "invoice",
			"account_country", "US",
			"account_name", "webhooks.cc demo",
			"amount_due", 2000,
			"amount_paid", 2000,
			"amount_remaining", 0,
			"billing_reason", "subscription_cycle",
			"currency", "usd",
			"customer", "cus_"+randomHex(14),
			"paid", true,
			"status", "paid",
			"hosted_invoice_url", "https://invoice.stripe.com/demo",
			"created", c.nowSec,
		))
	}
	return nil
}

func githubRepository() jsonx.Object {
	return o(
		"id", randomNumber(9),
		"name", "demo-repo",
		"full_name", "webhooks-cc/demo-repo",
		"private", false,
		"default_branch", "main",
		"html_url", "https://github.com/webhooks-cc/demo-repo",
	)
}

func githubSender() jsonx.Object {
	return o("login", "webhooks-cc-bot", "id", 987654, "type", "Bot")
}

func githubPayload(c payloadContext) any {
	before, after := randomHex(40), randomHex(40)
	repo := githubRepository()
	fullName := "webhooks-cc/demo-repo"
	commit := func() jsonx.Object {
		return o(
			"id", after,
			"message", "Update webhook integration tests",
			"timestamp", c.nowISO,
			"url", "https://github.com/"+fullName+"/commit/"+after,
			"author", o("name", "webhooks-cc-bot", "email", "bot@webhooks.cc"),
			"committer", o("name", "webhooks-cc-bot", "email", "bot@webhooks.cc"),
			"added", list{},
			"removed", list{},
			"modified", list{"src/webhooks.ts"},
		)
	}
	switch c.template {
	case "push":
		return o(
			"ref", "refs/heads/main",
			"before", before,
			"after", after,
			"repository", repo,
			"pusher", o("name", "webhooks-cc-bot", "email", "bot@webhooks.cc"),
			"sender", githubSender(),
			"created", false,
			"deleted", false,
			"forced", false,
			"compare", "https://github.com/"+fullName+"/compare/"+before+"..."+after,
			"commits", list{commit()},
			"head_commit", commit(),
		)
	case "pull_request.opened":
		return o(
			"action", "opened",
			"number", 42,
			"pull_request", o(
				"id", randomNumber(9),
				"number", 42,
				"state", "open",
				"title", "Add webhook retry logic",
				"body", "This PR improves retry handling for inbound webhooks.",
				"created_at", c.nowISO,
				"updated_at", c.nowISO,
				"html_url", "https://github.com/"+fullName+"/pull/42",
				"user", o("login", "webhooks-cc-bot", "id", 987654, "type", "Bot"),
				"draft", false,
				"head", o(
					"label", "webhooks-cc:feature/webhook-retries",
					"ref", "feature/webhook-retries",
					"sha", randomHex(40),
					"repo", repo,
				),
				"base", o(
					"label", "webhooks-cc:main",
					"ref", "main",
					"sha", randomHex(40),
					"repo", repo,
				),
			),
			"repository", repo,
			"sender", githubSender(),
		)
	case "ping":
		return o(
			"zen", "Keep it logically awesome.",
			"hook_id", randomNumber(7),
			"hook", o(
				"type", "Repository",
				"id", randomNumber(7),
				"name", "web",
				"active", true,
				"events", list{"push", "pull_request"},
				"config", o(
					"content_type", "json",
					"insecure_ssl", "0",
					"url", "https://go.webhooks.cc/w/demo",
				),
			),
			"repository", repo,
			"sender", githubSender(),
		)
	}
	return nil
}

func shopifyPayload(c payloadContext) any {
	order := func(status, price, title, sku string) jsonx.Object {
		return o(
			"id", randomNumber(10),
			"admin_graphql_api_id", "gid://shopify/Order/"+randomDigits(10),
			"email", "customer@example.com",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
			"currency", "USD",
			"financial_status", status,
			"fulfillment_status", nil,
			"total_price", price,
			"subtotal_price", price,
			"total_tax", "0.00",
			"line_items", list{o(
				"id", randomNumber(10),
				"admin_graphql_api_id", "gid://shopify/LineItem/"+randomDigits(10),
				"title", title,
				"quantity", 1,
				"sku", sku,
				"price", price,
			)},
		)
	}
	switch c.template {
	case "orders/create":
		return order("pending", "19.99", "Demo Item", "DEMO-001")
	case "orders/paid":
		return order("paid", "49.00", "Webhook Pro Plan", "WHK-PRO")
	case "products/update":
		return o(
			"id", randomNumber(10),
			"admin_graphql_api_id", "gid://shopify/Product/"+randomDigits(10),
			"title", "Webhook Tester Hoodie",
			"body_html", "<strong>Updated product details</strong>",
			"vendor", "webhooks.cc",
			"product_type", "Apparel",
			"handle", "webhook-tester-hoodie",
			"status", "active",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
			"variants", list{o(
				"id", randomNumber(10),
				"product_id", randomNumber(10),
				"title", "Default Title",
				"price", "39.00",
				"sku", "WHK-HOODIE",
				"position", 1,
				"inventory_policy", "deny",
				"fulfillment_service", "manual",
				"inventory_management", "shopify",
			)},
		)
	case "app/uninstalled":
		return o(
			"id", randomNumber(10),
			"name", "Demo Shop",
			"email", "owner@example.com",
			"domain", "demo-shop.myshopify.com",
			"myshopify_domain", "demo-shop.myshopify.com",
			"country_name", "United States",
			"currency", "USD",
			"plan_name", "basic",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
		)
	}
	return nil
}

func metaPayload(c payloadContext) any {
	switch c.template {
	case "whatsapp.messages":
		return o(
			"object", "whatsapp_business_account",
			"entry", list{o(
				"id", randomDigits(15),
				"changes", list{o(
					"field", "messages",
					"value", o(
						"messaging_product", "whatsapp",
						"metadata", o(
							"display_phone_number", "15550100",
							"phone_number_id", randomDigits(15),
						),
						"contacts", list{o("profile", o("name", "Ada"), "wa_id", "15551234567")},
						"messages", list{o(
							"from", "15551234567",
							"id", "wamid."+randomHex(20),
							"timestamp", strconv.FormatInt(c.nowSec, 10),
							"type", "text",
							"text", o("body", "Hello from webhooks.cc"),
						)},
					),
				)},
			)},
		)
	case "page.messages":
		return o(
			"object", "page",
			"entry", list{o(
				"id", randomDigits(15),
				"time", c.nowSec,
				"messaging", list{o(
					"sender", o("id", randomDigits(15)),
					"recipient", o("id", randomDigits(15)),
					"timestamp", c.nowSec*1000,
					"message", o("mid", "m_"+randomHex(20), "text", "hi"),
				)},
			)},
		)
	case "instagram.comments":
		return o(
			"object", "instagram",
			"entry", list{o(
				"id", randomDigits(15),
				"time", c.nowSec,
				"changes", list{o("field", "comments", "value", o("id", randomDigits(15), "text", "nice!"))},
			)},
		)
	}
	return nil
}

func lemonSqueezyPayload(c payloadContext) any {
	var data jsonx.Object
	switch c.template {
	case "subscription_created":
		data = o(
			"type", "subscriptions",
			"id", randomDigits(6),
			"attributes", o(
				"status", "active",
				"product_name", "Pro Plan",
				"variant_name", "Monthly",
				"user_email", "customer@example.com",
			),
		)
	case "subscription_payment_success":
		data = o(
			"type", "subscription-invoices",
			"id", randomDigits(6),
			"attributes", o(
				"status", "paid",
				"total", 1999,
				"currency", "USD",
				"billing_reason", "renewal",
			),
		)
	default:
		data = o(
			"type", "orders",
			"id", randomDigits(6),
			"attributes", o(
				"status", "paid",
				"total", 1999,
				"currency", "USD",
				"user_email", "customer@example.com",
				"product_name", "Pro Plan",
			),
		)
	}
	return o("meta", o("event_name", c.event, "custom_data", o()), "data", data)
}

func coinbasePayload(c payloadContext) any {
	return o("event", o(
		"id", randomUUID(),
		"type", c.event,
		"api_version", "2018-03-22",
		"created_at", c.nowISO,
		"data", o(
			"code", strings.ToUpper(randomHex(8)),
			"name", "Order",
			"description", "webhooks.cc test charge",
			"pricing", o("local", o("amount", "19.99", "currency", "USD")),
			"metadata", o(),
			"timeline", list{o("time", c.nowISO, "status", "NEW")},
		),
	))
}

func razorpayPayload(c payloadContext) any {
	return o(
		"entity", "event",
		"account_id", "acc_"+randomHex(14),
		"event", c.event,
		"contains", list{"payment"},
		"payload", o("payment", o("entity", o(
			"id", "pay_"+randomHex(14),
			"entity", "payment",
			"amount", 5000,
			"currency", "INR",
			"status", "captured",
			"order_id", "order_"+randomHex(14),
			"method", "card",
			"email", "customer@example.com",
		))),
		"created_at", c.nowSec,
	)
}

func calPayload(c payloadContext) any {
	return o(
		"triggerEvent", c.event,
		"createdAt", c.nowISO,
		"payload", o(
			"type", "30min",
			"title", "30min between Ada and webhooks.cc",
			"startTime", c.nowISO,
			"endTime", c.nowISO,
			"organizer", o("email", "ada@example.com", "name", "Ada", "timeZone", "UTC"),
			"attendees", list{o("email", "guest@example.com", "name", "Guest", "timeZone", "UTC")},
			"uid", randomHex(16),
		),
	)
}

func intercomPayload(c payloadContext) any {
	return o(
		"type", "notification_event",
		"id", "notif_"+randomHex(12),
		"topic", c.event,
		"app_id", randomHex(8),
		"created_at", c.nowSec,
		"data", o(
			"type", "notification_event_data",
			"item", o("type", "conversation", "id", randomDigits(10), "created_at", c.nowSec),
		),
	)
}

func telegramPayload(c payloadContext) any {
	updateID := randomNumber(9)
	from := o("id", 42, "is_bot", false, "first_name", "Ada", "username", "ada")
	chat := o("id", 42, "type", "private", "first_name", "Ada", "username", "ada")
	switch c.template {
	case "message":
		return o("update_id", updateID, "message", o(
			"message_id", 1,
			"from", from,
			"chat", chat,
			"date", c.nowSec,
			"text", "hi",
		))
	case "callback_query":
		return o("update_id", updateID, "callback_query", o(
			"id", randomDigits(12),
			"from", from,
			"chat_instance", randomDigits(18),
			"data", "button_1",
		))
	case "edited_message":
		return o("update_id", updateID, "edited_message", o(
			"message_id", 1,
			"from", from,
			"chat", chat,
			"date", c.nowSec,
			"edit_date", c.nowSec,
			"text", "edited",
		))
	}
	return nil
}

func squarePayload(c payloadContext) any {
	switch c.template {
	case "payment.created":
		return o(
			"merchant_id", strings.ToUpper(randomHex(13)),
			"type", "payment.created",
			"event_id", randomUUID(),
			"created_at", c.nowISO,
			"data", o(
				"type", "payment",
				"id", randomHex(22),
				"object", o("payment", o(
					"id", randomHex(22),
					"amount_money", o("amount", 2000, "currency", "USD"),
					"status", "APPROVED",
				)),
			),
		)
	case "payment.updated":
		return o(
			"merchant_id", strings.ToUpper(randomHex(13)),
			"type", "payment.updated",
			"event_id", randomUUID(),
			"created_at", c.nowISO,
			"data", o(
				"type", "payment",
				"id", randomHex(22),
				"object", o("payment", o("id", randomHex(22), "status", "COMPLETED")),
			),
		)
	case "refund.created":
		return o(
			"merchant_id", strings.ToUpper(randomHex(13)),
			"type", "refund.created",
			"event_id", randomUUID(),
			"created_at", c.nowISO,
			"data", o(
				"type", "refund",
				"id", randomHex(22),
				"object", o("refund", o(
					"id", randomHex(22),
					"amount_money", o("amount", 500, "currency", "USD"),
					"status", "PENDING",
				)),
			),
		)
	}
	return nil
}

func hubspotPayload(c payloadContext) any {
	// HubSpot delivers an array of subscription notifications.
	return list{o(
		"eventId", randomNumber(9),
		"subscriptionId", 1,
		"portalId", 123,
		"occurredAt", c.nowSec*1000,
		"subscriptionType", c.event,
		"attemptNumber", 0,
		"objectId", 1,
		"propertyName", nil,
		"propertyValue", nil,
	)}
}

func mailgunPayload(c payloadContext) any {
	// The signature is a placeholder; Build signs timestamp + token and patches
	// the body's signature object.
	return o(
		"signature", o("timestamp", strconv.FormatInt(c.nowSec, 10), "token", randomHex(50), "signature", ""),
		"event-data", o(
			"event", c.event,
			"id", randomHex(22),
			"timestamp", c.nowSec,
			"recipient", "user@example.com",
			"message", o("headers", o("message-id", randomHex(20)+"@example.com")),
		),
	)
}

func calendlyPayload(c payloadContext) any {
	return o(
		"event", c.event,
		"created_at", c.nowISO,
		"payload", o(
			"email", "ada@example.com",
			"name", "Ada",
			"scheduled_event", o(
				"start_time", c.nowISO,
				"end_time", c.nowISO,
				"name", "30 Minute Meeting",
			),
		),
	)
}

func muxPayload(c payloadContext) any {
	return o(
		"type", c.event,
		"object", o("type", "asset", "id", randomHex(20)),
		"id", randomUUID(),
		"created_at", c.nowISO,
		"data", o("status", "preparing", "id", randomHex(20)),
	)
}

func resendPayload(c payloadContext) any {
	// Resend events are { type, created_at, data } with no top-level id: the
	// delivery id travels in the svix-id header.
	email := o(
		"created_at", c.nowISO,
		"email_id", randomUUID(),
		"message_id", "<"+randomUUID()+"@email.example.com>",
		"from", "Acme <onboarding@resend.dev>",
		"to", list{"delivered@resend.dev"},
		"subject", "Sending this example",
		"tags", o("category", "confirm_email"),
	)
	var data any
	switch c.template {
	case "email.sent", "email.delivered":
		data = email
	case "email.bounced":
		data = with(email, "bounce", o(
			"message", "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces.",
			"subType", "Suppressed",
			"type", "Permanent",
		))
	case "email.clicked":
		data = with(email, "click", o(
			"ipAddress", "122.115.53.11",
			"link", "https://resend.com",
			"timestamp", c.nowISO,
			"userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
		))
	case "contact.created":
		data = o(
			"id", randomUUID(),
			"audience_id", randomUUID(),
			"segment_ids", list{},
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
			"email", "ada@example.com",
			"first_name", nil,
			"last_name", nil,
			"unsubscribed", false,
		)
	}
	return o("type", c.event, "created_at", c.nowISO, "data", data)
}

func workosPayload(c payloadContext) any {
	// WorkOS events are { event, id, data, created_at, context }. IDs are
	// prefixed ULIDs; uppercase hex is a subset of the ULID alphabet.
	ulid := func() string { return "01" + strings.ToUpper(randomHex(24)) }
	organizationID := "org_" + ulid()
	userID := "user_" + ulid()
	var data any
	switch c.template {
	case "user.created":
		data = o(
			"object", "user",
			"id", userID,
			"email", "todd@example.com",
			"first_name", "Todd",
			"last_name", "Rundgren",
			"email_verified", false,
			"profile_picture_url", nil,
			"last_sign_in_at", nil,
			"external_id", nil,
			"metadata", o(),
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
		)
	case "dsync.user.created":
		data = o(
			"id", "directory_user_"+ulid(),
			"directory_id", "directory_"+ulid(),
			"organization_id", organizationID,
			"idp_id", randomDigits(4),
			"email", "lela.block@example.com",
			"first_name", "Lela",
			"last_name", "Block",
			"state", "active",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
			"custom_attributes", o(
				"department", "Engineering",
				"job_title", "Software Engineer",
				"username", "lela.block@example.com",
			),
			"role", o("slug", "member"),
			"roles", list{o("slug", "member")},
		)
	case "connection.activated":
		data = o(
			"object", "connection",
			"id", "conn_"+ulid(),
			"organization_id", organizationID,
			"state", "active",
			"connection_type", "OktaSAML",
			"name", "Foo Corp's Connection",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
			"domains", list{o(
				"id", "org_domain_"+ulid(),
				"object", "connection_domain",
				"domain", "foo-corp.com",
			)},
		)
	case "session.created":
		data = o(
			"object", "session",
			"id", "session_"+ulid(),
			"user_id", userID,
			"organization_id", organizationID,
			"ip_address", "192.0.2.1",
			"user_agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36",
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
		)
	case "organization.created":
		data = o(
			"object", "organization",
			"id", organizationID,
			"name", "Foo Corp",
			"external_id", nil,
			"domains", list{o(
				"object", "organization_domain",
				"id", "org_domain_"+ulid(),
				"organization_id", organizationID,
				"domain", "foo-corp.com",
				"state", "verified",
				"verification_strategy", "manual",
				"created_at", c.nowISO,
				"updated_at", c.nowISO,
			)},
			"created_at", c.nowISO,
			"updated_at", c.nowISO,
		)
	}
	return o(
		"event", c.event,
		"id", "event_"+ulid(),
		"data", data,
		"created_at", c.nowISO,
		"context", o(),
	)
}

func sentryPayload(c payloadContext) any {
	// The body's resource (issue or error) and action must agree with the
	// sentry-hook-resource header and the selected template.
	issueData := o("issue", o(
		"id", randomDigits(10),
		"title", "TypeError: undefined is not a function",
		"culprit", "app/main",
		"level", "error",
	))
	switch c.template {
	case "issue.resolved":
		return o(
			"action", "resolved",
			"installation", o("uuid", randomUUID()),
			"data", issueData,
			"actor", o("type", "user", "id", randomDigits(7), "name", "webhooks-cc-bot"),
		)
	case "error.created":
		return o(
			"action", "created",
			"installation", o("uuid", randomUUID()),
			"data", o("error", o(
				"event_id", randomHex(32),
				"title", "TypeError: undefined is not a function",
				"level", "error",
				"culprit", "app/main",
			)),
			"actor", o("type", "application", "id", "sentry"),
		)
	}
	return o(
		"action", "created",
		"installation", o("uuid", randomUUID()),
		"data", issueData,
		"actor", o("type", "application", "id", "sentry"),
	)
}

func bitbucketPayload(c payloadContext) any {
	// repo:push and pullrequest:* events have different shapes; emit the one
	// the template names so PR consumers get a pullrequest object.
	repository := o("name", "demo-repo", "full_name", "webhooks-cc/demo-repo")
	actor := o("display_name", "webhooks-cc-bot")
	pullRequest := func(state string) jsonx.Object {
		return o(
			"pullrequest", o(
				"id", randomNumber(4),
				"title", "Add tier-2 webhook providers",
				"state", state,
				"source", o("branch", o("name", "feature/tier-2")),
				"destination", o("branch", o("name", "main")),
				"author", actor,
			),
			"repository", repository,
			"actor", actor,
		)
	}
	switch c.template {
	case "pullrequest:created":
		return pullRequest("OPEN")
	case "pullrequest:fulfilled":
		return pullRequest("MERGED")
	}
	return o(
		"push", o("changes", list{o("new", o("name", "main", "type", "branch"))}),
		"repository", repository,
		"actor", actor,
	)
}

func docusignPayload(c payloadContext) any {
	status := "completed"
	if c.template == "envelope-declined" {
		status = "declined"
	}
	data := o(
		"accountId", randomDigits(8),
		"envelopeId", randomUUID(),
		"status", status,
		"statusChangedDateTime", c.nowISO,
	)
	if c.template == "recipient-completed" {
		data.Set("recipientId", "1")
	}
	return o(
		"event", c.event,
		"apiVersion", "v2.1",
		"uri", "/restapi/v2.1/accounts/"+randomDigits(8)+"/envelopes/"+randomUUID(),
		"retryCount", 0,
		"configurationId", randomUUID(),
		"generatedDateTime", c.nowISO,
		"data", data,
	)
}

func adyenPayload(c payloadContext) any {
	value, originalReference := 1130, randomDigits(16)
	if c.event == "REFUND" {
		value = 500
	}
	if c.event == "AUTHORISATION" {
		originalReference = ""
	}
	item := o(
		"additionalData", o("hmacSignature", ""),
		"amount", o("value", value, "currency", "EUR"),
		"pspReference", randomDigits(16),
		"originalReference", originalReference,
		"eventCode", c.event,
		"eventDate", c.nowISO,
		"merchantAccountCode", "TestMerchant",
		"merchantReference", "TestPayment-"+randomDigits(13),
		"paymentMethod", "visa",
		"success", "true",
	)
	return o("live", "false", "notificationItems", list{o("NotificationRequestItem", item)})
}

func paypalPayload(c payloadContext) any {
	resourceType := map[string]string{
		"PAYMENT.CAPTURE.COMPLETED":    "capture",
		"CHECKOUT.ORDER.APPROVED":      "checkout-order",
		"BILLING.SUBSCRIPTION.CREATED": "subscription",
	}[c.event]
	if resourceType == "" {
		resourceType = "resource"
	}
	status := "APPROVED"
	if strings.HasSuffix(c.event, "COMPLETED") {
		status = "COMPLETED"
	}
	return o(
		"id", "WH-"+strings.ToUpper(randomHex(8)),
		"event_version", "1.0",
		"create_time", c.nowISO,
		"resource_type", resourceType,
		"event_type", c.event,
		"summary", "Mock PayPal "+c.event+" event",
		"resource", o(
			"id", strings.ToUpper(randomHex(16)),
			"status", status,
			"amount", o("currency_code", "USD", "value", "10.00"),
		),
		"links", list{},
	)
}

func slackPayload(c payloadContext) (built, error) {
	headers := userAgent("Slackbot 1.0 (+https://api.slack.com/robots)")
	switch c.template {
	case "slash_command":
		var body string
		switch {
		case !c.body.present:
			body = formEncode([][2]string{
				{"token", randomHex(24)},
				{"team_id", "T" + strings.ToUpper(randomHex(8))},
				{"team_domain", "webhooks-cc"},
				{"channel_id", "C" + strings.ToUpper(randomHex(8))},
				{"channel_name", "general"},
				{"user_id", "U" + strings.ToUpper(randomHex(8))},
				{"user_name", "webhooks-bot"},
				{"command", "/webhook-test"},
				{"text", "hello world"},
				{"response_url", "https://hooks.slack.com/commands/demo"},
				{"trigger_id", randomHex(12)},
			})
		case c.body.isText:
			body = c.body.text
		default:
			params, ok := stringRecord(c.body.value)
			if !ok {
				return built{}, errors.New("slack slash_command body override must be a string or an object")
			}
			body = formEncode(params)
		}
		return built{body: body, contentType: contentForm, headers: headers}, nil
	case "url_verification":
		return c.json(o(
			"token", randomHex(24),
			"challenge", randomHex(16),
			"type", "url_verification",
		), headers)
	}
	ts := strconv.FormatInt(c.nowSec, 10) + ".000100"
	return c.json(o(
		"token", randomHex(24),
		"team_id", "T"+strings.ToUpper(randomHex(8)),
		"api_app_id", "A"+strings.ToUpper(randomHex(8)),
		"type", "event_callback",
		"event", o(
			"type", "app_mention",
			"user", "U"+strings.ToUpper(randomHex(8)),
			"text", "hello from webhooks.cc",
			"ts", ts,
			"channel", "C"+strings.ToUpper(randomHex(8)),
			"event_ts", ts,
		),
		"event_id", "Ev"+randomHex(12),
		"event_time", c.nowSec,
		"authed_users", list{"U" + strings.ToUpper(randomHex(8))},
	), headers)
}

func paddlePayload(c payloadContext) any {
	event := func(kind string, data jsonx.Object) jsonx.Object {
		return o(
			"event_id", randomUUID(),
			"event_type", kind,
			"occurred_at", c.nowISO,
			"notification_id", randomUUID(),
			"data", data,
		)
	}
	switch c.template {
	case "transaction.completed":
		return event("transaction.completed", o(
			"id", "txn_"+randomHex(12),
			"status", "completed",
			"customer_id", "ctm_"+randomHex(12),
			"currency_code", "USD",
			"total", "49.00",
		))
	case "subscription.created":
		return event("subscription.created", o(
			"id", "sub_"+randomHex(12),
			"status", "active",
			"customer_id", "ctm_"+randomHex(12),
			"next_billed_at", c.nowISO,
		))
	case "subscription.updated":
		return event("subscription.updated", o(
			"id", "sub_"+randomHex(12),
			"status", "past_due",
			"customer_id", "ctm_"+randomHex(12),
			"next_billed_at", c.nowISO,
		))
	}
	return nil
}

func linearPayload(c payloadContext) any {
	issueID := randomUUID()
	issueURL := "https://linear.app/webhooks-cc/issue/ENG-42/" + issueID
	switch c.template {
	case "issue.create":
		return o(
			"action", "create",
			"type", "Issue",
			"webhookTimestamp", c.nowISO,
			"data", o(
				"id", issueID,
				"identifier", "ENG-42",
				"title", "Investigate webhook retry regression",
				"description", "Created from the webhooks.cc Linear template",
				"url", issueURL,
			),
		)
	case "issue.update":
		return o(
			"action", "update",
			"type", "Issue",
			"webhookTimestamp", c.nowISO,
			"data", o(
				"id", issueID,
				"identifier", "ENG-42",
				"title", "Investigate webhook retry regression",
				"state", o("name", "In Progress"),
				"url", issueURL,
			),
		)
	case "comment.create":
		return o(
			"action", "create",
			"type", "Comment",
			"webhookTimestamp", c.nowISO,
			"data", o(
				"id", randomUUID(),
				"body", "Looks good from the webhook sandbox.",
				"issue", o(
					"id", issueID,
					"identifier", "ENG-42",
					"title", "Investigate webhook retry regression",
				),
				"user", o("id", randomUUID(), "name", "webhooks.cc bot"),
			),
		)
	}
	return nil
}

func clerkPayload(c payloadContext) any {
	userID := "user_" + randomHex(24)
	nowMS := c.nowSec * 1000
	user := func(lastName string) jsonx.Object {
		return o(
			"id", userID,
			"object", "user",
			"email_addresses", list{o(
				"id", "idn_"+randomHex(24),
				"email_address", "user@example.com",
				"verification", o("status", "verified", "strategy", "email_code"),
			)},
			"first_name", "Jane",
			"last_name", lastName,
			"created_at", nowMS,
			"updated_at", nowMS,
		)
	}
	event := func(kind string, data jsonx.Object) jsonx.Object {
		return o("data", data, "object", "event", "type", kind, "timestamp", nowMS)
	}
	switch c.template {
	case "user.created":
		return event("user.created", user("Doe"))
	case "user.updated":
		return event("user.updated", user("Smith"))
	case "user.deleted":
		return event("user.deleted", o("id", userID, "object", "user", "deleted", true))
	case "session.created":
		return event("session.created", o(
			"id", "sess_"+randomHex(24),
			"object", "session",
			"user_id", userID,
			"status", "active",
			"created_at", nowMS,
			"updated_at", nowMS,
			"expire_at", (c.nowSec+86400)*1000,
		))
	}
	return nil
}

func vercelPayload(c payloadContext) any {
	deploymentID := "dpl_" + randomHex(20)
	project := o("id", "prj_"+randomHex(20), "name", "webhooks-cc-web")
	team := o("id", "team_"+randomHex(20), "name", "webhooks-cc")
	event := func(kind string, deployment jsonx.Object) jsonx.Object {
		return o(
			"id", randomUUID(),
			"type", kind,
			"createdAt", c.nowSec*1000,
			"payload", o("deployment", deployment, "project", project, "team", team),
		)
	}
	deploymentURL := func() string { return "webhooks-cc-web-" + randomHex(8) + ".vercel.app" }
	switch c.template {
	case "deployment.created":
		return event("deployment.created", o(
			"id", deploymentID,
			"name", "webhooks-cc-web",
			"url", deploymentURL(),
			"meta", o(
				"githubCommitRef", "main",
				"githubCommitSha", randomHex(40),
				"githubCommitMessage", "Update webhook templates",
			),
		))
	case "deployment.succeeded":
		return event("deployment.succeeded", o(
			"id", deploymentID,
			"name", "webhooks-cc-web",
			"url", deploymentURL(),
			"readyState", "READY",
		))
	case "deployment.error":
		return event("deployment.error", o(
			"id", deploymentID,
			"name", "webhooks-cc-web",
			"url", deploymentURL(),
			"readyState", "ERROR",
			"errorMessage", "Build failed: exit code 1",
		))
	}
	return nil
}

func gitlabPayload(c payloadContext) any {
	projectID := randomNumber(7)
	project := o(
		"id", projectID,
		"name", "demo-repo",
		"web_url", "https://gitlab.com/webhooks-cc/demo-repo",
		"namespace", "webhooks-cc",
		"default_branch", "main",
	)
	switch c.template {
	case "push":
		return o(
			"object_kind", "push",
			"event_name", "push",
			"before", randomHex(40),
			"after", randomHex(40),
			"ref", "refs/heads/main",
			"checkout_sha", randomHex(40),
			"user_id", randomNumber(5),
			"user_name", "webhooks-cc-bot",
			"user_email", "bot@webhooks.cc",
			"project_id", projectID,
			"project", project,
			"commits", list{o(
				"id", randomHex(40),
				"message", "Update webhook integration tests",
				"title", "Update webhook integration tests",
				"timestamp", c.nowISO,
				"url", "https://gitlab.com/webhooks-cc/demo-repo/-/commit/"+randomHex(40),
				"author", o("name", "webhooks-cc-bot", "email", "bot@webhooks.cc"),
				"added", list{},
				"modified", list{"src/webhooks.ts"},
				"removed", list{},
			)},
			"total_commits_count", 1,
		)
	case "merge_request":
		return o(
			"object_kind", "merge_request",
			"event_type", "merge_request",
			"user", o(
				"id", randomNumber(5),
				"name", "webhooks-cc-bot",
				"username", "webhooks-cc-bot",
				"email", "bot@webhooks.cc",
			),
			"project", project,
			"object_attributes", o(
				"id", randomNumber(7),
				"iid", 42,
				"title", "Add webhook retry logic",
				"description", "This MR improves retry handling for inbound webhooks.",
				"state", "opened",
				"action", "open",
				"source_branch", "feature/webhook-retries",
				"target_branch", "main",
				"created_at", c.nowISO,
				"updated_at", c.nowISO,
				"url", "https://gitlab.com/webhooks-cc/demo-repo/-/merge_requests/42",
			),
		)
	}
	return nil
}

func typeformPayload(c payloadContext) any {
	formID := strings.ToUpper(randomHex(6))
	token := randomToken("token")
	eventType := c.event
	if c.template == "payment" {
		eventType = "form_response"
	}
	field := func(id, ref, kind string) jsonx.Object { return o("id", id, "ref", ref, "type", kind) }
	switch c.template {
	case "form_response":
		return o(
			"event_id", randomUUID(),
			"event_type", eventType,
			"form_response", o(
				"form_id", formID,
				"token", token,
				"landed_at", c.nowISO,
				"submitted_at", c.nowISO,
				"hidden", o("source", "webhooks-cc"),
				"definition", o(
					"id", formID,
					"title", "Webhook test form",
					"fields", list{
						with(field("field_name", "name", "short_text"), "title", "What is your name?"),
						with(field("field_email", "email", "email"), "title", "What is your email?"),
					},
				),
				"answers", list{
					o("type", "text", "text", "Ada Lovelace", "field", field("field_name", "name", "short_text")),
					o("type", "email", "email", "ada@example.com", "field", field("field_email", "email", "email")),
				},
			),
		)
	case "partial_response":
		return o(
			"event_id", randomUUID(),
			"event_type", eventType,
			"form_response", o(
				"form_id", formID,
				"token", token,
				"landed_at", c.nowISO,
				"submitted_at", nil,
				"definition", o(
					"id", formID,
					"title", "Webhook test form",
					"fields", list{with(field("field_email", "email", "email"), "title", "What is your email?")},
				),
				"answers", list{
					o("type", "email", "email", "partial@example.com", "field", field("field_email", "email", "email")),
				},
			),
		)
	case "payment":
		return o(
			"event_id", randomUUID(),
			"event_type", eventType,
			"form_response", o(
				"form_id", formID,
				"token", token,
				"landed_at", c.nowISO,
				"submitted_at", c.nowISO,
				"definition", o(
					"id", formID,
					"title", "Order form",
					"fields", list{with(field("field_payment", "payment", "payment"), "title", "Payment")},
				),
				"answers", list{o(
					"type", "payment",
					"payment", o("amount", "1999", "last4", "4242", "name", "Ada Lovelace", "success", true),
					"field", field("field_payment", "payment", "payment"),
				)},
			),
		)
	}
	return nil
}

func twilioPayload(c payloadContext) (built, error) {
	headers := userAgent("TwilioProxy/1.1")
	var params [][2]string
	switch {
	case c.body.present && c.body.isText:
		return built{body: c.body.text, contentType: contentForm, headers: headers, twilioParams: formDecode(c.body.text)}, nil
	case c.body.present:
		var ok bool
		params, ok = stringRecord(c.body.value)
		if !ok {
			return built{}, errors.New("twilio template body override must be a string or an object")
		}
	default:
		params = defaultTwilioParams(c.template)
	}
	return built{body: formEncode(params), contentType: contentForm, headers: headers, twilioParams: params}, nil
}

func defaultTwilioParams(template string) [][2]string {
	switch template {
	case "messaging.status_callback":
		return [][2]string{
			{"AccountSid", randomSID("AC")},
			{"ApiVersion", "2010-04-01"},
			{"MessageSid", randomSID("SM")},
			{"SmsSid", randomSID("SM")},
			{"MessageStatus", "delivered"},
			{"SmsStatus", "delivered"},
			{"To", "+14155559876"},
			{"From", "+14155550123"},
			{"ErrorCode", ""},
		}
	case "voice.incoming_call":
		return [][2]string{
			{"AccountSid", randomSID("AC")},
			{"ApiVersion", "2010-04-01"},
			{"CallSid", randomSID("CA")},
			{"CallStatus", "ringing"},
			{"Direction", "inbound"},
			{"From", "+14155550123"},
			{"To", "+14155559876"},
			{"CallerCity", "SAN FRANCISCO"},
			{"CallerState", "CA"},
			{"CallerCountry", "US"},
			{"CallerZip", "94105"},
			{"CalledCity", ""},
			{"CalledState", ""},
			{"CalledCountry", "US"},
			{"CalledZip", ""},
		}
	}
	return [][2]string{
		{"AccountSid", randomSID("AC")},
		{"ApiVersion", "2010-04-01"},
		{"MessageSid", randomSID("SM")},
		{"SmsSid", randomSID("SM")},
		{"SmsMessageSid", randomSID("SM")},
		{"From", "+14155550123"},
		{"To", "+14155559876"},
		{"Body", "Hello from webhooks.cc"},
		{"NumMedia", "0"},
		{"NumSegments", "1"},
		{"MessageStatus", "received"},
		{"SmsStatus", "received"},
		{"FromCity", "SAN FRANCISCO"},
		{"FromState", "CA"},
		{"FromCountry", "US"},
		{"FromZip", "94105"},
		{"ToCity", ""},
		{"ToState", ""},
		{"ToCountry", "US"},
		{"ToZip", ""},
	}
}

func sendgridPayload(template string, nowSec int64) any {
	event := func(email, kind string, fields ...any) list {
		return list{with(o(
			"sg_event_id", randomHex(22),
			"sg_message_id", randomHex(20)+"."+randomDigits(4),
			"email", email,
			"timestamp", nowSec,
			"event", kind,
		), fields...)}
	}
	switch template {
	case "delivered":
		return event("recipient@example.com", "delivered",
			"smtp_id", "<"+randomHex(20)+"@example.com>",
			"ip", "168.1.1.1",
			"response", "250 OK",
			"category", list{"webhooks-cc-test"},
		)
	case "open":
		return event("recipient@example.com", "open",
			"ip", "72.14.199.28",
			"useragent", "Mozilla/5.0",
			"category", list{"webhooks-cc-test"},
		)
	case "bounce":
		return event("bounced@example.com", "bounce",
			"type", "bounce",
			"status", "5.1.1",
			"reason", "550 5.1.1 The email account does not exist.",
			"ip", "168.1.1.1",
			"category", list{"webhooks-cc-test"},
		)
	case "spam_report":
		return event("complainant@example.com", "spamreport", "category", list{"webhooks-cc-test"})
	}
	return nil
}

func discordPayload(template string) any {
	switch template {
	case "interaction_create":
		return o(
			"id", randomHex(18),
			"application_id", randomHex(18),
			"type", 2,
			"data", o("id", randomHex(18), "name", "webhook-test", "type", 1),
			"guild_id", randomHex(18),
			"channel_id", randomHex(18),
			"token", randomHex(40),
			"version", 1,
		)
	case "message_component":
		return o(
			"id", randomHex(18),
			"application_id", randomHex(18),
			"type", 3,
			"data", o("custom_id", "click_me", "component_type", 2),
			"guild_id", randomHex(18),
			"channel_id", randomHex(18),
			"token", randomHex(40),
			"version", 1,
		)
	case "ping":
		return o(
			"id", randomHex(18),
			"application_id", randomHex(18),
			"type", 1,
			"version", 1,
		)
	}
	return nil
}

func plaidPayload(template string) any {
	switch template {
	case "TRANSACTIONS":
		return o(
			"webhook_type", "TRANSACTIONS",
			"webhook_code", "DEFAULT_UPDATE",
			"item_id", "item_"+randomHex(8),
			"new_transactions", 1,
		)
	case "ITEM":
		return o(
			"webhook_type", "ITEM",
			"webhook_code", "ERROR",
			"item_id", "item_"+randomHex(8),
			"error", o("error_type", "ITEM_ERROR", "error_code", "WEBHOOK_UPDATE_ACKNOWLEDGED"),
		)
	case "AUTH":
		return o(
			"webhook_type", "AUTH",
			"webhook_code", "AUTOMATICALLY_VERIFIED",
			"item_id", "item_"+randomHex(8),
			"account_id", "account_"+randomHex(8),
		)
	}
	return nil
}
