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
        verify_signature("sendgrid", b"", &headers(&[]), b"", None, None),
        VerificationResult::Skipped(_)
    ));
}

// ── Unknown provider ──

#[test]
fn unknown_provider_skipped() {
    assert!(matches!(
        verify_signature("unknown_provider", b"", &headers(&[]), b"", None, None),
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
