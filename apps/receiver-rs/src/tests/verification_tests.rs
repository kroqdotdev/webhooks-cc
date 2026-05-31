use super::*;
use base64::Engine;

fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn make_hmac_sha256(secret: &str, payload: &str) -> String {
    hex::encode(hmac_sha256(secret.as_bytes(), payload.as_bytes()))
}

fn make_hmac_sha256_b64(secret: &[u8], payload: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, payload.as_bytes()))
}

fn make_hmac_sha1_b64(secret: &str, payload: &str) -> String {
    base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(secret.as_bytes(), payload.as_bytes()))
}

fn make_hmac_sha1(secret: &str, payload: &str) -> String {
    hex::encode(hmac_sha1(secret.as_bytes(), payload.as_bytes()))
}

// ── Auto-detection ──

#[test]
fn detect_stripe() {
    let h = headers(&[("stripe-signature", "t=123,v1=abc")]);
    assert_eq!(detect_provider(&h), Some("stripe"));
}

#[test]
fn detect_github() {
    let h = headers(&[("x-hub-signature-256", "sha256=abc")]);
    assert_eq!(detect_provider(&h), Some("github"));
}

#[test]
fn detect_shopify() {
    let h = headers(&[("x-shopify-hmac-sha256", "abc")]);
    assert_eq!(detect_provider(&h), Some("shopify"));
}

#[test]
fn detect_twilio() {
    let h = headers(&[("x-twilio-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("twilio"));
}

#[test]
fn detect_slack() {
    let h = headers(&[
        ("x-slack-signature", "v0=abc"),
        ("x-slack-request-timestamp", "123"),
    ]);
    assert_eq!(detect_provider(&h), Some("slack"));
}

#[test]
fn detect_paddle() {
    let h = headers(&[("paddle-signature", "ts=123;h1=abc")]);
    assert_eq!(detect_provider(&h), Some("paddle"));
}

#[test]
fn detect_linear() {
    let h = headers(&[("linear-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("linear"));
}

#[test]
fn detect_vercel() {
    let h = headers(&[("x-vercel-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("vercel"));
}

#[test]
fn detect_gitlab() {
    let h = headers(&[("x-gitlab-token", "abc")]);
    assert_eq!(detect_provider(&h), Some("gitlab"));
}

#[test]
fn detect_gitlab_unsigned_event_header() {
    let h = headers(&[("x-gitlab-event", "Push Hook")]);
    assert_eq!(detect_provider(&h), Some("gitlab"));
}

#[test]
fn detect_typeform() {
    let h = headers(&[("typeform-signature", "sha256=abc")]);
    assert_eq!(detect_provider(&h), Some("typeform"));
}

#[test]
fn detect_github_unsigned_event_header() {
    let h = headers(&[("x-github-event", "push")]);
    assert_eq!(detect_provider(&h), Some("github"));
}

#[test]
fn detect_shopify_unsigned_topic_header() {
    let h = headers(&[("x-shopify-topic", "orders/create")]);
    assert_eq!(detect_provider(&h), Some("shopify"));
}

#[test]
fn detect_clerk() {
    let h = headers(&[
        ("svix-id", "msg_123"),
        ("svix-timestamp", "123"),
        ("svix-signature", "v1,abc"),
    ]);
    assert_eq!(detect_provider(&h), Some("clerk"));
}

#[test]
fn detect_discord() {
    let h = headers(&[
        ("x-signature-ed25519", "abc"),
        ("x-signature-timestamp", "123"),
    ]);
    assert_eq!(detect_provider(&h), Some("discord"));
}

#[test]
fn detect_standard_webhooks() {
    let h = headers(&[
        ("webhook-id", "msg_123"),
        ("webhook-signature", "v1,abc"),
        ("webhook-timestamp", "123"),
    ]);
    assert_eq!(detect_provider(&h), Some("standard-webhooks"));
}

#[test]
fn does_not_detect_standard_webhooks_without_timestamp() {
    let h = headers(&[("webhook-id", "msg_123"), ("webhook-signature", "v1,abc")]);
    assert_eq!(detect_provider(&h), None);
}

#[test]
fn detect_none() {
    let h = headers(&[("content-type", "application/json")]);
    assert_eq!(detect_provider(&h), None);
}

// ── Stripe ──

#[test]
fn stripe_valid() {
    let secret = "whsec_test_secret";
    let body = b"{\"type\":\"invoice.paid\"}";
    let ts = "1712764800";
    let payload = format!("{ts}.{}", std::str::from_utf8(body).unwrap());
    let sig = make_hmac_sha256(secret, &payload);
    let h = headers(&[("stripe-signature", &format!("t={ts},v1={sig}"))]);

    assert!(matches!(
        verify_stripe(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn stripe_wrong_secret() {
    let body = b"{}";
    let ts = "1712764800";
    let payload = format!("{ts}.{{}}",);
    let sig = make_hmac_sha256("wrong_secret", &payload);
    let h = headers(&[("stripe-signature", &format!("t={ts},v1={sig}"))]);

    assert!(matches!(
        verify_stripe(b"correct_secret", &h, body),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn stripe_missing_header() {
    let h = headers(&[]);
    assert!(matches!(
        verify_stripe(b"secret", &h, b""),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn stripe_malformed_header() {
    let h = headers(&[("stripe-signature", "garbage")]);
    assert!(matches!(
        verify_stripe(b"secret", &h, b""),
        VerificationResult::Invalid(_)
    ));
}

// ── GitHub ──

#[test]
fn github_valid() {
    let secret = "my_github_secret";
    let body = b"{\"action\":\"opened\"}";
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-hub-signature-256", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_github(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn github_wrong_secret() {
    let body = b"{}";
    let sig = make_hmac_sha256("wrong", "{}");
    let h = headers(&[("x-hub-signature-256", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_github(b"correct", &h, body),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn github_missing_header() {
    assert!(matches!(
        verify_github(b"secret", &headers(&[]), b""),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn github_no_prefix() {
    let h = headers(&[("x-hub-signature-256", "deadbeef")]);
    assert!(matches!(
        verify_github(b"secret", &h, b""),
        VerificationResult::Invalid(_)
    ));
}

// ── Shopify ──

#[test]
fn shopify_valid() {
    let secret = "shopify_secret";
    let body = b"{\"topic\":\"orders/create\"}";
    let sig = make_hmac_sha256_b64(secret.as_bytes(), std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-shopify-hmac-sha256", &sig)]);

    assert!(matches!(
        verify_shopify(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn shopify_wrong_secret() {
    let body = b"{}";
    let sig = make_hmac_sha256_b64(b"wrong", "{}");
    let h = headers(&[("x-shopify-hmac-sha256", &sig)]);

    assert!(matches!(
        verify_shopify(b"correct", &h, body),
        VerificationResult::Invalid(_)
    ));
}

// ── Twilio ──

#[test]
fn twilio_valid() {
    let secret = "twilio_auth_token";
    let url = "https://example.com/webhook";
    let body = b"From=%2B1234&Body=hello";
    // Build expected payload the same way the verification function does:
    // parse form body, sort by key then value, concatenate url+key+value pairs
    let mut params: Vec<(String, String)> = url::form_urlencoded::parse(body)
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    params.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut payload = url.to_string();
    for (k, v) in &params {
        payload.push_str(k);
        payload.push_str(v);
    }
    let sig = make_hmac_sha1_b64(secret, &payload);
    let h = headers(&[("x-twilio-signature", &sig)]);

    assert!(matches!(
        verify_twilio(secret.as_bytes(), &h, body, Some(url)),
        VerificationResult::Valid
    ));
}

#[test]
fn twilio_missing_url() {
    let h = headers(&[("x-twilio-signature", "abc")]);
    assert!(matches!(
        verify_twilio(b"secret", &h, b"", None),
        VerificationResult::Skipped(_)
    ));
}

// ── Slack ──

#[test]
fn slack_valid() {
    let secret = "slack_signing_secret";
    let body = b"token=abc&command=/test";
    let ts = "1712764800";
    let body_str = std::str::from_utf8(body).unwrap();
    let payload = format!("v0:{ts}:{body_str}");
    let sig = make_hmac_sha256(secret, &payload);
    let h = headers(&[
        ("x-slack-signature", &format!("v0={sig}")),
        ("x-slack-request-timestamp", ts),
    ]);

    assert!(matches!(
        verify_slack(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn slack_missing_timestamp() {
    let h = headers(&[("x-slack-signature", "v0=abc")]);
    assert!(matches!(
        verify_slack(b"secret", &h, b""),
        VerificationResult::Skipped(_)
    ));
}

// ── Paddle ──

#[test]
fn paddle_valid() {
    let secret = "paddle_webhook_secret";
    let body = b"{\"event_type\":\"subscription.activated\"}";
    let ts = "1712764800";
    let body_str = std::str::from_utf8(body).unwrap();
    let payload = format!("{ts}:{body_str}");
    let sig = make_hmac_sha256(secret, &payload);
    let h = headers(&[("paddle-signature", &format!("ts={ts};h1={sig}"))]);

    assert!(matches!(
        verify_paddle(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn paddle_comma_separator() {
    let secret = "secret";
    let body = b"{}";
    let ts = "123";
    let sig = make_hmac_sha256(secret, &format!("{ts}:{{}}"));
    let h = headers(&[("paddle-signature", &format!("ts={ts},h1={sig}"))]);

    assert!(matches!(
        verify_paddle(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

// ── Linear ──

#[test]
fn linear_valid_no_prefix() {
    let secret = "linear_secret";
    let body = b"{\"action\":\"create\"}";
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("linear-signature", &sig)]);

    assert!(matches!(
        verify_linear(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn linear_valid_with_prefix() {
    let secret = "linear_secret";
    let body = b"{\"action\":\"create\"}";
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("linear-signature", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_linear(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

// ── Vercel ──

#[test]
fn vercel_valid() {
    let secret = "vercel_secret";
    let body = b"{\"type\":\"deployment.created\"}";
    let sig = hex::encode(hmac_sha1(secret.as_bytes(), body));
    let h = headers(&[("x-vercel-signature", &sig)]);

    assert!(matches!(
        verify_vercel(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

// ── GitLab ──

#[test]
fn gitlab_valid() {
    let secret = "my_gitlab_token";
    let h = headers(&[("x-gitlab-token", secret)]);

    assert!(matches!(
        verify_gitlab(secret.as_bytes(), &h),
        VerificationResult::Valid
    ));
}

#[test]
fn gitlab_wrong_token() {
    let h = headers(&[("x-gitlab-token", "wrong_token")]);
    assert!(matches!(
        verify_gitlab(b"correct_token", &h),
        VerificationResult::Invalid(_)
    ));
}

// ── Standard Webhooks ──

#[test]
fn standard_webhooks_valid() {
    let raw_secret = b"test_secret_bytes_here_1234";
    let b64_secret = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(raw_secret)
    );
    let body = b"{\"type\":\"test\"}";
    let msg_id = "msg_abc123";
    let ts = "1712764800";
    let body_str = std::str::from_utf8(body).unwrap();
    let payload = format!("{msg_id}.{ts}.{body_str}");
    let sig = make_hmac_sha256_b64(raw_secret, &payload);

    let h = headers(&[
        ("webhook-id", msg_id),
        ("webhook-timestamp", ts),
        ("webhook-signature", &format!("v1,{sig}")),
    ]);

    assert!(matches!(
        verify_standard_webhooks(b64_secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn standard_webhooks_missing_id() {
    let h = headers(&[
        ("webhook-timestamp", "123"),
        ("webhook-signature", "v1,abc"),
    ]);
    assert!(matches!(
        verify_standard_webhooks(b"secret", &h, b""),
        VerificationResult::Skipped(_)
    ));
}

// ── Clerk ──

#[test]
fn clerk_normalizes_svix_headers() {
    // Clerk sends svix-* headers; verify_clerk should normalize to webhook-*
    let raw_secret = b"clerk_secret_bytes";
    let b64_secret = format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(raw_secret)
    );
    let body = b"{\"type\":\"user.created\"}";
    let msg_id = "msg_clerk";
    let ts = "1712764800";
    let body_str = std::str::from_utf8(body).unwrap();
    let payload = format!("{msg_id}.{ts}.{body_str}");
    let sig = make_hmac_sha256_b64(raw_secret, &payload);

    let h = headers(&[
        ("svix-id", msg_id),
        ("svix-timestamp", ts),
        ("svix-signature", &format!("v1,{sig}")),
    ]);

    assert!(matches!(
        verify_clerk(b64_secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

// ── Discord ──

#[test]
fn discord_valid() {
    use ed25519_dalek::{Signer, SigningKey};

    // Generate a test keypair
    let signing_key = SigningKey::from_bytes(&[42u8; 32]);
    let verifying_key = signing_key.verifying_key();
    let public_key_hex = hex::encode(verifying_key.as_bytes());

    let body = b"{\"type\":1}";
    let timestamp = "1712764800";
    let mut message = timestamp.as_bytes().to_vec();
    message.extend_from_slice(body);
    let signature = signing_key.sign(&message);
    let sig_hex = hex::encode(signature.to_bytes());

    let h = headers(&[
        ("x-signature-ed25519", &sig_hex),
        ("x-signature-timestamp", timestamp),
    ]);

    assert!(matches!(
        verify_discord(public_key_hex.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn discord_wrong_key() {
    use ed25519_dalek::{Signer, SigningKey};

    let signing_key = SigningKey::from_bytes(&[42u8; 32]);
    let wrong_key = SigningKey::from_bytes(&[99u8; 32]);
    let wrong_pk_hex = hex::encode(wrong_key.verifying_key().as_bytes());

    let body = b"{}";
    let ts = "123";
    let mut msg = ts.as_bytes().to_vec();
    msg.extend_from_slice(body);
    let sig = signing_key.sign(&msg);

    let h = headers(&[
        ("x-signature-ed25519", &hex::encode(sig.to_bytes())),
        ("x-signature-timestamp", ts),
    ]);

    assert!(matches!(
        verify_discord(wrong_pk_hex.as_bytes(), &h, body),
        VerificationResult::Invalid(_)
    ));
}

// ── Typeform ──

#[test]
fn typeform_valid() {
    let secret = "typeform_secret";
    let body = br#"{"event_type":"form_response","form_response":{"token":"abc"}}"#;
    let sig = make_hmac_sha256_b64(secret.as_bytes(), std::str::from_utf8(body).unwrap());
    let h = headers(&[("typeform-signature", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_typeform(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn typeform_wrong_secret() {
    let secret = "typeform_secret";
    let body = br#"{"event_type":"form_response"}"#;
    let sig = make_hmac_sha256_b64(secret.as_bytes(), std::str::from_utf8(body).unwrap());
    let h = headers(&[("typeform-signature", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_typeform(b"wrong_secret", &h, body),
        VerificationResult::Invalid(_)
    ));
}

// ── Generic HMAC ──

#[test]
fn generic_hmac_hex() {
    let secret = "my_custom_secret";
    let body = b"payload";
    let sig = make_hmac_sha256(secret, "payload");
    let h = headers(&[("x-my-signature", &sig)]);

    assert!(matches!(
        verify_generic_hmac(secret.as_bytes(), &h, body, Some("x-my-signature")),
        VerificationResult::Valid
    ));
}

#[test]
fn generic_hmac_base64() {
    let secret = "my_custom_secret";
    let body = b"payload";
    let sig = make_hmac_sha256_b64(secret.as_bytes(), "payload");
    let h = headers(&[("x-my-signature", &sig)]);

    assert!(matches!(
        verify_generic_hmac(secret.as_bytes(), &h, body, Some("x-my-signature")),
        VerificationResult::Valid
    ));
}

#[test]
fn generic_hmac_sha256_prefix() {
    let secret = "my_custom_secret";
    let body = b"payload";
    let sig = make_hmac_sha256(secret, "payload");
    let h = headers(&[("x-my-signature", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_generic_hmac(secret.as_bytes(), &h, body, Some("x-my-signature")),
        VerificationResult::Valid
    ));
}

#[test]
fn generic_hmac_no_header_name() {
    assert!(matches!(
        verify_generic_hmac(b"secret", &headers(&[]), b"", None),
        VerificationResult::Skipped(_)
    ));
}

// ── Sendgrid ──

#[test]
fn sendgrid_skipped() {
    assert!(matches!(
        verify_signature("sendgrid", b"", &headers(&[]), b"", None, None, None),
        VerificationResult::Skipped(_)
    ));
}

// ── Unknown provider ──

#[test]
fn unknown_provider_skipped() {
    assert!(matches!(
        verify_signature("unknown_provider", b"", &headers(&[]), b"", None, None, None),
        VerificationResult::Skipped(_)
    ));
}

// ── Edge cases ──

#[test]
fn empty_body_github() {
    let secret = "secret";
    let body = b"";
    let sig = make_hmac_sha256(secret, "");
    let h = headers(&[("x-hub-signature-256", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_github(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn case_insensitive_headers() {
    let secret = "secret";
    let body = b"{}";
    let sig = make_hmac_sha256(secret, "{}");
    // Header key in mixed case
    let h = headers(&[("X-Hub-Signature-256", &format!("sha256={sig}"))]);

    assert!(matches!(
        verify_github(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn stripe_multiple_v1_signatures() {
    let secret = "whsec_test";
    let body = b"{}";
    let ts = "123";
    let payload = format!("{ts}.{{}}");
    let correct_sig = make_hmac_sha256(secret, &payload);
    // Multiple v1 values; one correct, one wrong
    let header = format!("t={ts},v1=wrong_sig,v1={correct_sig}");
    let h = headers(&[("stripe-signature", &header)]);

    assert!(matches!(
        verify_stripe(secret.as_bytes(), &h, body),
        VerificationResult::Valid
    ));
}

#[test]
fn signature_error_serializes_to_json() {
    let err = SignatureError::mismatch("expected_abc", "received_xyz");
    let json = serde_json::to_string(&err).unwrap();
    assert!(json.contains("\"code\":\"mismatch\""));
    assert!(json.contains("\"expected\":\"expected_abc\""));
    assert!(json.contains("\"received\":\"received_xyz\""));
}

// ── Tier-1 providers ──

#[test]
fn detect_coinbase_commerce() {
    let h = headers(&[("x-cc-webhook-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("coinbase-commerce"));
}

#[test]
fn detect_razorpay() {
    let h = headers(&[("x-razorpay-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("razorpay"));
}

#[test]
fn detect_cal() {
    let h = headers(&[("x-cal-signature-256", "abc")]);
    assert_eq!(detect_provider(&h), Some("cal"));
}

#[test]
fn detect_telegram() {
    let h = headers(&[("x-telegram-bot-api-secret-token", "secret")]);
    assert_eq!(detect_provider(&h), Some("telegram"));
}

#[test]
fn detect_intercom_sha1() {
    let h = headers(&[("x-hub-signature", "sha1=deadbeef")]);
    assert_eq!(detect_provider(&h), Some("intercom"));
}

#[test]
fn github_with_legacy_sha1_still_detects_as_github_not_intercom() {
    // GitHub sends x-hub-signature (sha1) alongside x-hub-signature-256 + x-github-event.
    // GitHub must win — Intercom is checked only after GitHub.
    let h = headers(&[
        ("x-github-event", "push"),
        ("x-hub-signature", "sha1=deadbeef"),
        ("x-hub-signature-256", "sha256=cafef00d"),
    ]);
    assert_eq!(detect_provider(&h), Some("github"));
}

#[test]
fn verify_meta_reuses_github() {
    let secret = "app_secret";
    let body = br#"{"object":"whatsapp_business_account"}"#;
    let sig = format!(
        "sha256={}",
        make_hmac_sha256(secret, std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-hub-signature-256", &sig)]);
    assert!(matches!(
        verify_signature("meta", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_meta_wrong_secret() {
    let body = br#"{"object":"page"}"#;
    let sig = format!(
        "sha256={}",
        make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-hub-signature-256", &sig)]);
    assert!(matches!(
        verify_signature("meta", b"app_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_lemonsqueezy_valid() {
    let secret = "ls_secret";
    let body = br#"{"meta":{"event_name":"order_created"}}"#;
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-signature", &sig)]);
    assert!(matches!(
        verify_signature("lemonsqueezy", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_lemonsqueezy_wrong_secret() {
    let body = br#"{"meta":{"event_name":"order_created"}}"#;
    let sig = make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-signature", &sig)]);
    assert!(matches!(
        verify_signature("lemonsqueezy", b"ls_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_coinbase_commerce_valid() {
    let secret = "cb_secret";
    let body = br#"{"event":{"type":"charge:confirmed"}}"#;
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-cc-webhook-signature", &sig)]);
    assert!(matches!(
        verify_signature("coinbase-commerce", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_coinbase_commerce_wrong_secret() {
    let body = br#"{"event":{"type":"charge:confirmed"}}"#;
    let sig = make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-cc-webhook-signature", &sig)]);
    assert!(matches!(
        verify_signature("coinbase-commerce", b"cb_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_razorpay_valid() {
    let secret = "rp_secret";
    let body = br#"{"event":"payment.captured"}"#;
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-razorpay-signature", &sig)]);
    assert!(matches!(
        verify_signature("razorpay", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_razorpay_wrong_secret() {
    let body = br#"{"event":"payment.captured"}"#;
    let sig = make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-razorpay-signature", &sig)]);
    assert!(matches!(
        verify_signature("razorpay", b"rp_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_cal_valid() {
    let secret = "cal_secret";
    let body = br#"{"triggerEvent":"BOOKING_CREATED"}"#;
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-cal-signature-256", &sig)]);
    assert!(matches!(
        verify_signature("cal", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_cal_wrong_secret() {
    let body = br#"{"triggerEvent":"BOOKING_CREATED"}"#;
    let sig = make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap());
    let h = headers(&[("x-cal-signature-256", &sig)]);
    assert!(matches!(
        verify_signature("cal", b"cal_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_hex_provider_accepts_optional_prefix() {
    // The shared hex verifier also accepts a `sha256=` prefixed form.
    let secret = "rp_secret";
    let body = br#"{"event":"payment.captured"}"#;
    let sig = format!(
        "sha256={}",
        make_hmac_sha256(secret, std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-razorpay-signature", &sig)]);
    assert!(matches!(
        verify_signature("razorpay", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_intercom_valid() {
    let secret = "ic_secret";
    let body = br#"{"type":"notification_event","topic":"conversation.user.created"}"#;
    let sig = format!(
        "sha1={}",
        make_hmac_sha1(secret, std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-hub-signature", &sig)]);
    assert!(matches!(
        verify_signature("intercom", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_intercom_wrong_secret() {
    let body = br#"{"type":"notification_event"}"#;
    let sig = format!(
        "sha1={}",
        make_hmac_sha1("wrong", std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-hub-signature", &sig)]);
    assert!(matches!(
        verify_signature("intercom", b"ic_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_intercom_rejects_sha256_prefix() {
    // Intercom uses sha1=; a sha256= prefixed signature must be rejected.
    let secret = "ic_secret";
    let body = br#"{"type":"notification_event"}"#;
    let sig = format!(
        "sha256={}",
        make_hmac_sha256(secret, std::str::from_utf8(body).unwrap())
    );
    let h = headers(&[("x-hub-signature", &sig)]);
    assert!(matches!(
        verify_signature("intercom", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_telegram_valid() {
    let secret = "tg_secret_token";
    let h = headers(&[("x-telegram-bot-api-secret-token", secret)]);
    assert!(matches!(
        verify_signature("telegram", secret.as_bytes(), &h, b"{}", None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_telegram_wrong_token() {
    let h = headers(&[("x-telegram-bot-api-secret-token", "wrong_token")]);
    assert!(matches!(
        verify_signature("telegram", b"correct_token", &h, b"{}", None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_telegram_missing_header() {
    assert!(matches!(
        verify_signature("telegram", b"secret", &headers(&[]), b"{}", None, None, None),
        VerificationResult::Skipped(_)
    ));
}

// ── Tier-2: Square (URL + body HMAC, base64) ──

#[test]
fn detect_square() {
    let h = headers(&[("x-square-hmacsha256-signature", "abc")]);
    assert_eq!(detect_provider(&h), Some("square"));
}

#[test]
fn verify_square_url_plus_body() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"{"type":"payment.created"}"#;
    let payload = format!("{url}{}", std::str::from_utf8(body).unwrap());
    let sig = make_hmac_sha256_b64(b"sq_key", &payload);
    let h = headers(&[("x-square-hmacsha256-signature", &sig)]);
    assert!(matches!(
        verify_signature("square", b"sq_key", &h, body, None, Some(url), None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_square_wrong_secret() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"{"type":"payment.created"}"#;
    let payload = format!("{url}{}", std::str::from_utf8(body).unwrap());
    let sig = make_hmac_sha256_b64(b"sq_key", &payload);
    let h = headers(&[("x-square-hmacsha256-signature", &sig)]);
    assert!(matches!(
        verify_signature("square", b"wrong_key", &h, body, None, Some(url), None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_square_wrong_url() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"{"type":"payment.created"}"#;
    // Sign over the real URL, but verify against a different URL → mismatch.
    let payload = format!("{url}{}", std::str::from_utf8(body).unwrap());
    let sig = make_hmac_sha256_b64(b"sq_key", &payload);
    let h = headers(&[("x-square-hmacsha256-signature", &sig)]);
    assert!(matches!(
        verify_signature(
            "square",
            b"sq_key",
            &h,
            body,
            None,
            Some("https://go.webhooks.cc/w/other"),
            None,
        ),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_square_missing_header() {
    assert!(matches!(
        verify_signature(
            "square",
            b"sq_key",
            &headers(&[]),
            b"{}",
            None,
            Some("https://go.webhooks.cc/w/demo"),
            None,
        ),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn verify_square_missing_url() {
    let h = headers(&[("x-square-hmacsha256-signature", "abc")]);
    assert!(matches!(
        verify_signature("square", b"sq_key", &h, b"{}", None, None, None),
        VerificationResult::Skipped(_)
    ));
}

// ── Tier-2: HubSpot (method + URI + body + timestamp HMAC, base64) ──

/// Current epoch milliseconds, for building fresh HubSpot timestamps in tests.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Build a valid HubSpot v3 signature over `method + url + body + timestamp(ms)`.
fn make_hubspot_sig(secret: &[u8], method: &str, url: &str, body: &[u8], ts_ms: i64) -> String {
    let mut payload = Vec::new();
    payload.extend_from_slice(method.as_bytes());
    payload.extend_from_slice(url.as_bytes());
    payload.extend_from_slice(body);
    payload.extend_from_slice(ts_ms.to_string().as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, &payload))
}

#[test]
fn detect_hubspot() {
    let h = headers(&[("x-hubspot-signature-v3", "abc")]);
    assert_eq!(detect_provider(&h), Some("hubspot"));
}

#[test]
fn verify_hubspot_valid() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"[{"subscriptionType":"contact.creation"}]"#;
    let ts = now_ms();
    let sig = make_hubspot_sig(b"hs_secret", "POST", url, body, ts);
    let h = headers(&[
        ("x-hubspot-signature-v3", &sig),
        ("x-hubspot-request-timestamp", &ts.to_string()),
    ]);
    assert!(matches!(
        verify_signature("hubspot", b"hs_secret", &h, body, None, Some(url), Some("POST")),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_hubspot_wrong_secret() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"[{"subscriptionType":"contact.creation"}]"#;
    let ts = now_ms();
    let sig = make_hubspot_sig(b"hs_secret", "POST", url, body, ts);
    let h = headers(&[
        ("x-hubspot-signature-v3", &sig),
        ("x-hubspot-request-timestamp", &ts.to_string()),
    ]);
    assert!(matches!(
        verify_signature("hubspot", b"wrong_secret", &h, body, None, Some(url), Some("POST")),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_hubspot_wrong_method() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"[{"subscriptionType":"contact.creation"}]"#;
    let ts = now_ms();
    // Signature computed for POST, but the request was a GET → mismatch.
    let sig = make_hubspot_sig(b"hs_secret", "POST", url, body, ts);
    let h = headers(&[
        ("x-hubspot-signature-v3", &sig),
        ("x-hubspot-request-timestamp", &ts.to_string()),
    ]);
    assert!(matches!(
        verify_signature("hubspot", b"hs_secret", &h, body, None, Some(url), Some("GET")),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_hubspot_expired_timestamp() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"[{"subscriptionType":"contact.creation"}]"#;
    // Timestamp 10 minutes in the past — outside the 5-minute window.
    let ts = now_ms() - 10 * 60 * 1000;
    let sig = make_hubspot_sig(b"hs_secret", "POST", url, body, ts);
    let h = headers(&[
        ("x-hubspot-signature-v3", &sig),
        ("x-hubspot-request-timestamp", &ts.to_string()),
    ]);
    // Even though the signature itself is correct, the stale timestamp is rejected.
    match verify_signature("hubspot", b"hs_secret", &h, body, None, Some(url), Some("POST")) {
        VerificationResult::Invalid(err) => assert_eq!(err.code, "timestamp_expired"),
        other => panic!("expected Invalid(timestamp_expired), got {other:?}"),
    }
}

#[test]
fn verify_hubspot_missing_url() {
    let url = "https://go.webhooks.cc/w/demo";
    let body = br#"[{"subscriptionType":"contact.creation"}]"#;
    let ts = now_ms();
    let sig = make_hubspot_sig(b"hs_secret", "POST", url, body, ts);
    let h = headers(&[
        ("x-hubspot-signature-v3", &sig),
        ("x-hubspot-request-timestamp", &ts.to_string()),
    ]);
    assert!(matches!(
        verify_signature("hubspot", b"hs_secret", &h, body, None, None, Some("POST")),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn verify_hubspot_missing_header() {
    assert!(matches!(
        verify_signature(
            "hubspot",
            b"hs_secret",
            &headers(&[]),
            b"[]",
            None,
            Some("https://go.webhooks.cc/w/demo"),
            Some("POST"),
        ),
        VerificationResult::Skipped(_)
    ));
}

// ── Tier-2: Mailgun (body-embedded HMAC-SHA256 over timestamp + token) ──

/// Build a Mailgun-style JSON body whose `signature.signature` is the hex
/// HMAC-SHA256 of `timestamp + token` keyed by `secret`.
fn make_mailgun_body(secret: &str, timestamp: &str, token: &str, event: &str) -> String {
    let sig = make_hmac_sha256(secret, &format!("{timestamp}{token}"));
    format!(
        r#"{{"signature":{{"timestamp":"{timestamp}","token":"{token}","signature":"{sig}"}},"event-data":{{"event":"{event}"}}}}"#
    )
}

#[test]
fn verify_mailgun_valid() {
    let secret = "mg_signing_key";
    let body = make_mailgun_body(secret, "1700000000", "deadbeefcafe", "delivered");
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), body.as_bytes(), None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_mailgun_wrong_secret() {
    let body = make_mailgun_body("mg_signing_key", "1700000000", "deadbeefcafe", "delivered");
    assert!(matches!(
        verify_signature("mailgun", b"wrong_secret", &headers(&[]), body.as_bytes(), None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_mailgun_tampered_token() {
    let secret = "mg_signing_key";
    // Signature computed for one token, but the body carries a different token.
    let sig = make_hmac_sha256(secret, "1700000000deadbeefcafe");
    let body = format!(
        r#"{{"signature":{{"timestamp":"1700000000","token":"OTHERTOKEN","signature":"{sig}"}},"event-data":{{"event":"delivered"}}}}"#
    );
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), body.as_bytes(), None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_mailgun_malformed_body_is_skipped_not_panic() {
    let secret = "mg_signing_key";
    // Non-JSON body → Skipped (never panics).
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), b"not json at all", None, None, None),
        VerificationResult::Skipped(_)
    ));
    // Truncated JSON → Skipped.
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), b"{", None, None, None),
        VerificationResult::Skipped(_)
    ));
    // Missing signature fields → Skipped.
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), br#"{"event-data":{}}"#, None, None, None),
        VerificationResult::Skipped(_)
    ));
    // Empty body → Skipped.
    assert!(matches!(
        verify_signature("mailgun", secret.as_bytes(), &headers(&[]), b"", None, None, None),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn mailgun_is_not_auto_detected() {
    // Mailgun has no distinctive header, so detect_provider must not key on the
    // body — owner-selected only.
    let body = make_mailgun_body("mg_signing_key", "1700000000", "deadbeefcafe", "delivered");
    let h = headers(&[]);
    // No header present means detection returns None even though the body is a
    // valid Mailgun payload.
    assert_eq!(detect_provider(&h), None);
    // Sanity: the body itself still verifies via the explicit provider path.
    assert!(matches!(
        verify_signature("mailgun", b"mg_signing_key", &h, body.as_bytes(), None, None, None),
        VerificationResult::Valid
    ));
}

// ── Tier-2: Calendly (Stripe-style t=,v1= HMAC-SHA256 hex) ──

/// Build a Calendly-style `t=<ts>,v1=<hex>` header signing `{ts}.{body}`.
fn make_calendly_header(secret: &str, ts: &str, body: &str) -> String {
    let sig = make_hmac_sha256(secret, &format!("{ts}.{body}"));
    format!("t={ts},v1={sig}")
}

#[test]
fn detect_calendly() {
    let h = headers(&[("calendly-webhook-signature", "t=123,v1=abc")]);
    assert_eq!(detect_provider(&h), Some("calendly"));
}

#[test]
fn verify_calendly_valid() {
    let secret = "cal_signing_key";
    let body = br#"{"event":"invitee.created"}"#;
    let sig = make_calendly_header(secret, "1700000000", std::str::from_utf8(body).unwrap());
    let h = headers(&[("calendly-webhook-signature", &sig)]);
    assert!(matches!(
        verify_signature("calendly", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_calendly_wrong_secret() {
    let body = br#"{"event":"invitee.created"}"#;
    let sig = make_calendly_header("cal_signing_key", "1700000000", std::str::from_utf8(body).unwrap());
    let h = headers(&[("calendly-webhook-signature", &sig)]);
    assert!(matches!(
        verify_signature("calendly", b"wrong_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_calendly_tampered_body() {
    let secret = "cal_signing_key";
    // Sign over one body, verify against a tampered body → mismatch.
    let sig = make_calendly_header(secret, "1700000000", r#"{"event":"invitee.created"}"#);
    let h = headers(&[("calendly-webhook-signature", &sig)]);
    assert!(matches!(
        verify_signature(
            "calendly",
            secret.as_bytes(),
            &h,
            br#"{"event":"invitee.canceled"}"#,
            None,
            None,
            None,
        ),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_calendly_missing_header() {
    let body = br#"{"event":"invitee.created"}"#;
    assert!(matches!(
        verify_signature("calendly", b"cal_signing_key", &headers(&[]), body, None, None, None),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn verify_calendly_malformed_header() {
    let body = br#"{"event":"invitee.created"}"#;
    let h = headers(&[("calendly-webhook-signature", "garbage")]);
    assert!(matches!(
        verify_signature("calendly", b"cal_signing_key", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

// ── Tier-2: Mux (Stripe-style t=,v1= HMAC-SHA256 hex, mux-signature) ──

/// Build a Mux-style `t=<ts>,v1=<hex>` header signing `{ts}.{body}`.
fn make_mux_header(secret: &str, ts: &str, body: &str) -> String {
    let sig = make_hmac_sha256(secret, &format!("{ts}.{body}"));
    format!("t={ts},v1={sig}")
}

#[test]
fn detect_mux() {
    let h = headers(&[("mux-signature", "t=123,v1=abc")]);
    assert_eq!(detect_provider(&h), Some("mux"));
}

#[test]
fn verify_mux_valid() {
    let secret = "mux_signing_secret";
    let body = br#"{"type":"video.asset.created"}"#;
    let sig = make_mux_header(secret, "1700000000", std::str::from_utf8(body).unwrap());
    let h = headers(&[("mux-signature", &sig)]);
    assert!(matches!(
        verify_signature("mux", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_mux_wrong_secret() {
    let body = br#"{"type":"video.asset.created"}"#;
    let sig = make_mux_header("mux_signing_secret", "1700000000", std::str::from_utf8(body).unwrap());
    let h = headers(&[("mux-signature", &sig)]);
    assert!(matches!(
        verify_signature("mux", b"wrong_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_mux_tampered_body() {
    let secret = "mux_signing_secret";
    // Sign over one body, verify against a tampered body → mismatch.
    let sig = make_mux_header(secret, "1700000000", r#"{"type":"video.asset.created"}"#);
    let h = headers(&[("mux-signature", &sig)]);
    assert!(matches!(
        verify_signature(
            "mux",
            secret.as_bytes(),
            &h,
            br#"{"type":"video.asset.ready"}"#,
            None,
            None,
            None,
        ),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_mux_missing_header() {
    let body = br#"{"type":"video.asset.created"}"#;
    assert!(matches!(
        verify_signature("mux", b"mux_signing_secret", &headers(&[]), body, None, None, None),
        VerificationResult::Skipped(_)
    ));
}

#[test]
fn verify_mux_malformed_header() {
    let body = br#"{"type":"video.asset.created"}"#;
    let h = headers(&[("mux-signature", "garbage")]);
    assert!(matches!(
        verify_signature("mux", b"mux_signing_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

// ── Tier-2: Sentry (HMAC-SHA256 hex over body, sentry-hook-signature) ──

#[test]
fn detect_sentry() {
    let h = headers(&[("sentry-hook-signature", "deadbeef")]);
    assert_eq!(detect_provider(&h), Some("sentry"));
}

#[test]
fn verify_sentry_valid() {
    let secret = "sentry_client_secret";
    let body = br#"{"action":"created","data":{"issue":{"id":"1"}}}"#;
    let sig = make_hmac_sha256(secret, std::str::from_utf8(body).unwrap());
    let h = headers(&[
        ("sentry-hook-signature", &sig),
        ("sentry-hook-resource", "issue"),
    ]);
    assert!(matches!(
        verify_signature("sentry", secret.as_bytes(), &h, body, None, None, None),
        VerificationResult::Valid
    ));
}

#[test]
fn verify_sentry_wrong_secret() {
    let body = br#"{"action":"created","data":{"issue":{"id":"1"}}}"#;
    let sig = make_hmac_sha256("wrong", std::str::from_utf8(body).unwrap());
    let h = headers(&[("sentry-hook-signature", &sig)]);
    assert!(matches!(
        verify_signature("sentry", b"sentry_client_secret", &h, body, None, None, None),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_sentry_tampered_body() {
    let secret = "sentry_client_secret";
    let sig = make_hmac_sha256(secret, r#"{"action":"created"}"#);
    let h = headers(&[("sentry-hook-signature", &sig)]);
    assert!(matches!(
        verify_signature(
            "sentry",
            secret.as_bytes(),
            &h,
            br#"{"action":"resolved"}"#,
            None,
            None,
            None
        ),
        VerificationResult::Invalid(_)
    ));
}

#[test]
fn verify_sentry_missing_header() {
    let body = br#"{"action":"created"}"#;
    assert!(matches!(
        verify_signature("sentry", b"sentry_client_secret", &headers(&[]), body, None, None, None),
        VerificationResult::Skipped(_)
    ));
}
