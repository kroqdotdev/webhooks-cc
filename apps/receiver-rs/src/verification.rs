//! Webhook signature verification for 13 providers.
//!
//! Mirrors the SDK's `verify.ts` but in Rust. Each provider has a dedicated
//! function that returns a [`VerificationResult`].

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::Sha256;
use std::collections::HashMap;

/// Result of a signature verification attempt.
#[derive(Debug, Clone)]
pub enum VerificationResult {
    /// Signature is valid.
    Valid,
    /// Signature is invalid (wrong secret, tampered body, expired timestamp, etc.).
    Invalid(SignatureError),
    /// Verification was skipped (missing header, unsupported provider, etc.).
    Skipped(SignatureError),
}

/// Structured error for the `signature_error` column on the requests table.
/// Serialized to JSON and stored as TEXT.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SignatureError {
    /// Error code: mismatch, missing_header, invalid_encoding, timestamp_expired, unsupported.
    pub code: &'static str,
    /// Computed (expected) signature, truncated to 64 chars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    /// Signature received from the header, truncated to 64 chars.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<String>,
    /// Parsed timestamp from the signature header (epoch seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// Which header was checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// Human-readable explanation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SignatureError {
    fn missing_header(header: &str) -> Self {
        Self {
            code: "missing_header",
            expected: None,
            received: None,
            timestamp: None,
            header: Some(header.to_string()),
            message: Some(format!("Missing required header: {header}")),
        }
    }

    fn mismatch(expected: &str, received: &str) -> Self {
        Self {
            code: "mismatch",
            expected: Some(truncate(expected, 64)),
            received: Some(truncate(received, 64)),
            timestamp: None,
            header: None,
            message: Some("Computed signature does not match the received signature".to_string()),
        }
    }

    fn invalid_encoding(msg: &str) -> Self {
        Self {
            code: "invalid_encoding",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some(msg.to_string()),
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max.saturating_sub(3)])
    }
}

/// Case-insensitive header lookup.
fn get_header<'a>(headers: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    let target = name.to_lowercase();
    for (key, value) in headers {
        if key.to_lowercase() == target {
            return Some(value.as_str());
        }
    }
    None
}

/// Constant-time byte comparison.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    constant_time_eq::constant_time_eq(a, b)
}

/// Constant-time string comparison.
fn ct_str_eq(a: &str, b: &str) -> bool {
    ct_eq(a.as_bytes(), b.as_bytes())
}

/// HMAC-SHA256 over the payload using the secret as a UTF-8 key.
fn hmac_sha256(secret: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(payload);
    mac.finalize().into_bytes().to_vec()
}

/// HMAC-SHA1 over the payload using the secret as a UTF-8 key.
fn hmac_sha1(secret: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(payload);
    mac.finalize().into_bytes().to_vec()
}

/// Verify a webhook signature for the given provider.
///
/// - `provider`: one of the supported provider names (e.g., "stripe", "github").
/// - `secret`: the decrypted signing secret (or public key for Discord).
/// - `headers`: the filtered request headers (lowercase keys from the webhook handler).
/// - `body`: the raw request body bytes.
/// - `signing_header`: custom header name (only used for "generic-hmac" provider).
/// - `request_url`: the full URL (only used for Twilio which signs the URL).
pub fn verify_signature(
    provider: &str,
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    signing_header: Option<&str>,
    request_url: Option<&str>,
) -> VerificationResult {
    match provider {
        "stripe" => verify_stripe(secret, headers, body),
        "github" => verify_github(secret, headers, body),
        "shopify" => verify_shopify(secret, headers, body),
        "twilio" => verify_twilio(secret, headers, body, request_url),
        "slack" => verify_slack(secret, headers, body),
        "paddle" => verify_paddle(secret, headers, body),
        "linear" => verify_linear(secret, headers, body),
        "vercel" => verify_vercel(secret, headers, body),
        "gitlab" => verify_gitlab(secret, headers),
        "clerk" => verify_clerk(secret, headers, body),
        "discord" => verify_discord(secret, headers, body),
        "standard-webhooks" => verify_standard_webhooks(secret, headers, body),
        "generic-hmac" => verify_generic_hmac(secret, headers, body, signing_header),
        "sendgrid" => VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some(
                "SendGrid uses IP allowlisting, not signatures. Signature verification is not applicable."
                    .to_string(),
            ),
        }),
        _ => VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some(format!("Unknown provider: {provider}")),
        }),
    }
}

/// Auto-detect the webhook provider from request headers.
///
/// Returns the provider name if a known signature header is found.
pub fn detect_provider(headers: &HashMap<String, String>) -> Option<&'static str> {
    // Check in priority order (most specific first)
    if get_header(headers, "stripe-signature").is_some() {
        return Some("stripe");
    }
    if get_header(headers, "x-hub-signature-256").is_some() {
        return Some("github");
    }
    if get_header(headers, "x-shopify-hmac-sha256").is_some() {
        return Some("shopify");
    }
    if get_header(headers, "x-twilio-signature").is_some() {
        return Some("twilio");
    }
    if get_header(headers, "x-slack-signature").is_some() {
        return Some("slack");
    }
    if get_header(headers, "paddle-signature").is_some() {
        return Some("paddle");
    }
    if get_header(headers, "linear-signature").is_some() {
        return Some("linear");
    }
    if get_header(headers, "x-vercel-signature").is_some() {
        return Some("vercel");
    }
    if get_header(headers, "x-gitlab-token").is_some() {
        return Some("gitlab");
    }
    // Clerk/Svix: check svix-id first (more specific), then webhook-id
    if get_header(headers, "svix-id").is_some() {
        return Some("clerk");
    }
    if get_header(headers, "x-signature-ed25519").is_some() {
        return Some("discord");
    }
    // Standard Webhooks: webhook-id + webhook-signature (must have both)
    if get_header(headers, "webhook-id").is_some()
        && get_header(headers, "webhook-signature").is_some()
    {
        return Some("standard-webhooks");
    }
    None
}

// ─── Provider-specific verification functions ────────────────────────────

/// Stripe: parse `t=...,v1=...` header, HMAC-SHA256 over `{timestamp}.{body}`.
fn verify_stripe(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "stripe-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let (timestamp, signatures) = match parse_stripe_header(sig_header) {
        Some(v) => v,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not parse stripe-signature header (expected t=...,v1=...)",
            ));
        }
    };

    let payload = format!("{timestamp}.{}", String::from_utf8_lossy(body));
    let expected = hex::encode(hmac_sha256(secret, payload.as_bytes()));

    if signatures
        .iter()
        .any(|sig| ct_str_eq(&sig.to_lowercase(), &expected))
    {
        VerificationResult::Valid
    } else {
        let received = signatures.first().map(|s| s.as_str()).unwrap_or("");
        let mut err = SignatureError::mismatch(&expected, received);
        err.timestamp = timestamp.parse::<i64>().ok();
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

fn parse_stripe_header(header: &str) -> Option<(String, Vec<String>)> {
    let mut timestamp = None;
    let mut signatures = Vec::new();

    for part in header.split(',') {
        let trimmed = part.trim();
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key {
                "t" => timestamp = Some(value.to_string()),
                "v1" => signatures.push(value.to_lowercase()),
                _ => {}
            }
        }
    }

    let ts = timestamp?;
    if signatures.is_empty() {
        return None;
    }
    Some((ts, signatures))
}

/// GitHub: HMAC-SHA256, header is `sha256={hex}`.
fn verify_github(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "x-hub-signature-256";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header.trim();
    let hex_sig = match received.strip_prefix("sha256=") {
        Some(h) => h,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Expected sha256= prefix on x-hub-signature-256",
            ));
        }
    };

    let expected = hex::encode(hmac_sha256(secret, body));
    if ct_str_eq(&hex_sig.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &hex_sig.to_lowercase());
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Shopify: HMAC-SHA256, base64 encoded.
fn verify_shopify(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    use base64::Engine;
    let header_name = "x-shopify-hmac-sha256";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let expected = base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, body));
    let received = sig_header.trim();

    if ct_str_eq(received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, received);
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Twilio: HMAC-SHA1 over URL + sorted form params, base64 encoded.
fn verify_twilio(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    request_url: Option<&str>,
) -> VerificationResult {
    use base64::Engine;
    let header_name = "x-twilio-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let Some(url) = request_url else {
        return VerificationResult::Skipped(SignatureError {
            code: "missing_header",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some("Twilio verification requires the request URL".to_string()),
        });
    };

    // Build payload: URL + sorted key/value pairs from form-encoded body
    let body_str = String::from_utf8_lossy(body);
    let mut params: Vec<(String, String)> = url::form_urlencoded::parse(body_str.as_bytes())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    params.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut payload = url.to_string();
    for (key, value) in &params {
        payload.push_str(key);
        payload.push_str(value);
    }

    let expected = base64::engine::general_purpose::STANDARD
        .encode(hmac_sha1(secret, payload.as_bytes()));
    let received = sig_header.trim();

    if ct_str_eq(received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, received);
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Slack: HMAC-SHA256 over `v0:{timestamp}:{body}`, header is `v0={hex}`.
fn verify_slack(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let sig_header_name = "x-slack-signature";
    let ts_header_name = "x-slack-request-timestamp";
    let Some(sig_header) = get_header(headers, sig_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(sig_header_name));
    };
    let Some(timestamp) = get_header(headers, ts_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(ts_header_name));
    };

    let received = sig_header.trim();
    let hex_sig = match received.strip_prefix("v0=") {
        Some(h) => h,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Expected v0= prefix on x-slack-signature",
            ));
        }
    };

    let payload = format!("v0:{timestamp}:{}", String::from_utf8_lossy(body));
    let expected = hex::encode(hmac_sha256(secret, payload.as_bytes()));

    if ct_str_eq(&hex_sig.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &hex_sig.to_lowercase());
        err.timestamp = timestamp.parse::<i64>().ok();
        err.header = Some(sig_header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Paddle: parse `ts=...,h1=...` or `ts=...;h1=...` header, HMAC-SHA256 over `{ts}:{body}`.
fn verify_paddle(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "paddle-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let (timestamp, signatures) = match parse_paddle_header(sig_header) {
        Some(v) => v,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not parse paddle-signature header (expected ts=...,h1=...)",
            ));
        }
    };

    let payload = format!("{timestamp}:{}", String::from_utf8_lossy(body));
    let expected = hex::encode(hmac_sha256(secret, payload.as_bytes()));

    if signatures
        .iter()
        .any(|sig| ct_str_eq(&sig.to_lowercase(), &expected))
    {
        VerificationResult::Valid
    } else {
        let received = signatures.first().map(|s| s.as_str()).unwrap_or("");
        let mut err = SignatureError::mismatch(&expected, received);
        err.timestamp = timestamp.parse::<i64>().ok();
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

fn parse_paddle_header(header: &str) -> Option<(String, Vec<String>)> {
    let mut timestamp = None;
    let mut signatures = Vec::new();

    // Paddle uses semicolons or commas as separators
    for part in header.split([';', ',']) {
        let trimmed = part.trim();
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim().to_lowercase();
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match key.as_str() {
                "ts" => timestamp = Some(value.to_string()),
                "h1" => signatures.push(value.to_lowercase()),
                _ => {}
            }
        }
    }

    let ts = timestamp?;
    if signatures.is_empty() {
        return None;
    }
    Some((ts, signatures))
}

/// Linear: HMAC-SHA256, header may have optional `sha256=` prefix.
fn verify_linear(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "linear-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header.trim();
    // Strip optional sha256= prefix
    let hex_sig = received.strip_prefix("sha256=").unwrap_or(received);

    let expected = hex::encode(hmac_sha256(secret, body));
    if ct_str_eq(&hex_sig.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &hex_sig.to_lowercase());
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Vercel: HMAC-SHA1, hex encoded.
fn verify_vercel(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "x-vercel-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let expected = hex::encode(hmac_sha1(secret, body));
    let received = sig_header.trim().to_lowercase();

    if ct_str_eq(&received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &received);
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// GitLab: constant-time token comparison (no HMAC).
fn verify_gitlab(secret: &[u8], headers: &HashMap<String, String>) -> VerificationResult {
    let header_name = "x-gitlab-token";
    let Some(token) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    if ct_eq(token.as_bytes(), secret) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError {
            code: "mismatch",
            expected: None, // Don't leak the expected token
            received: None,
            timestamp: None,
            header: Some(header_name.to_string()),
            message: Some("Token does not match".to_string()),
        };
        err.received = Some(truncate(token, 8)); // Show first 8 chars only
        VerificationResult::Invalid(err)
    }
}

/// Clerk: normalize svix-* headers to webhook-*, delegate to Standard Webhooks.
fn verify_clerk(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let mut normalized = headers.clone();
    // Map svix-* to webhook-* if webhook-* is not already present
    if let Some(id) = get_header(headers, "svix-id")
        && get_header(headers, "webhook-id").is_none() {
            normalized.insert("webhook-id".to_string(), id.to_string());
        }
    if let Some(ts) = get_header(headers, "svix-timestamp")
        && get_header(headers, "webhook-timestamp").is_none() {
            normalized.insert("webhook-timestamp".to_string(), ts.to_string());
        }
    if let Some(sig) = get_header(headers, "svix-signature")
        && get_header(headers, "webhook-signature").is_none() {
            normalized.insert("webhook-signature".to_string(), sig.to_string());
        }
    verify_standard_webhooks(secret, &normalized, body)
}

/// Discord: Ed25519 signature verification using the application's public key.
fn verify_discord(
    public_key_bytes: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let sig_header_name = "x-signature-ed25519";
    let ts_header_name = "x-signature-timestamp";
    let Some(sig_header) = get_header(headers, sig_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(sig_header_name));
    };
    let Some(timestamp) = get_header(headers, ts_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(ts_header_name));
    };

    // Decode hex public key
    let pk_bytes = match hex::decode(public_key_bytes) {
        Ok(b) => b,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not decode public key as hex",
            ));
        }
    };

    let verifying_key = match ed25519_dalek::VerifyingKey::from_bytes(
        pk_bytes
            .as_slice()
            .try_into()
            .unwrap_or(&[0u8; 32]),
    ) {
        Ok(vk) => vk,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Invalid Ed25519 public key",
            ));
        }
    };

    // Decode hex signature
    let sig_bytes = match hex::decode(sig_header.trim()) {
        Ok(b) => b,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not decode signature as hex",
            ));
        }
    };

    let sig_array: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Invalid Ed25519 signature length (expected 64 bytes)",
            ));
        }
    };
    let signature = ed25519_dalek::Signature::from_bytes(&sig_array);

    // Message = timestamp + body
    let mut message = timestamp.as_bytes().to_vec();
    message.extend_from_slice(body);

    use ed25519_dalek::Verifier;
    match verifying_key.verify(&message, &signature) {
        Ok(()) => VerificationResult::Valid,
        Err(_) => {
            let mut err = SignatureError {
                code: "mismatch",
                expected: None,
                received: Some(truncate(sig_header.trim(), 64)),
                timestamp: None,
                header: Some(sig_header_name.to_string()),
                message: Some("Ed25519 signature verification failed".to_string()),
            };
            err.timestamp = timestamp.parse::<i64>().ok();
            VerificationResult::Invalid(err)
        }
    }
}

/// Standard Webhooks: HMAC-SHA256 over `{msg_id}.{timestamp}.{body}`, base64 secret.
fn verify_standard_webhooks(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    use base64::Engine;

    let Some(msg_id) = get_header(headers, "webhook-id") else {
        return VerificationResult::Skipped(SignatureError::missing_header("webhook-id"));
    };
    let Some(timestamp) = get_header(headers, "webhook-timestamp") else {
        return VerificationResult::Skipped(SignatureError::missing_header("webhook-timestamp"));
    };
    let Some(sig_header) = get_header(headers, "webhook-signature") else {
        return VerificationResult::Skipped(SignatureError::missing_header("webhook-signature"));
    };

    // Decode the secret: strip optional whsec_ prefix, then base64 decode.
    // If base64 fails, use the raw secret bytes (same as SDK behavior).
    let secret_str = String::from_utf8_lossy(secret);
    let raw_secret = secret_str.strip_prefix("whsec_").unwrap_or(&secret_str);
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(raw_secret.as_bytes())
        .unwrap_or_else(|_| secret.to_vec());

    let payload = format!(
        "{msg_id}.{timestamp}.{}",
        String::from_utf8_lossy(body)
    );
    let expected =
        base64::engine::general_purpose::STANDARD.encode(hmac_sha256(&key_bytes, payload.as_bytes()));

    // Parse signatures: format is "v1,{base64}" possibly repeated with spaces
    let signatures = parse_standard_signatures(sig_header);
    if signatures.is_empty() {
        return VerificationResult::Invalid(SignatureError::invalid_encoding(
            "Could not parse webhook-signature header",
        ));
    }

    if signatures.iter().any(|sig| ct_str_eq(sig, &expected)) {
        VerificationResult::Valid
    } else {
        let received = signatures.first().map(|s| s.as_str()).unwrap_or("");
        let mut err = SignatureError::mismatch(&expected, received);
        err.timestamp = timestamp.parse::<i64>().ok();
        err.header = Some("webhook-signature".to_string());
        VerificationResult::Invalid(err)
    }
}

/// Parse Standard Webhooks signature header: `v1,{base64}` possibly with multiple entries.
fn parse_standard_signatures(header: &str) -> Vec<String> {
    let mut signatures = Vec::new();

    // Try regex-like pattern: find all `v1,{base64}` occurrences
    for part in header.split_whitespace() {
        if let Some(sig) = part.strip_prefix("v1,")
            && !sig.is_empty() {
                signatures.push(sig.to_string());
            }
    }

    if !signatures.is_empty() {
        return signatures;
    }

    // Fallback: split on comma, first part is version
    let parts: Vec<&str> = header.splitn(2, ',').collect();
    if parts.len() == 2 && parts[0].trim() == "v1" && !parts[1].trim().is_empty() {
        signatures.push(parts[1].trim().to_string());
    }

    signatures
}

/// Generic HMAC-SHA256: verify against a user-specified header.
fn verify_generic_hmac(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    header_name: Option<&str>,
) -> VerificationResult {
    let header_name = match header_name {
        Some(h) if !h.is_empty() => h,
        _ => {
            return VerificationResult::Skipped(SignatureError {
                code: "missing_header",
                expected: None,
                received: None,
                timestamp: None,
                header: None,
                message: Some("Generic HMAC requires a signing_header configuration".to_string()),
            });
        }
    };

    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let expected_hex = hex::encode(hmac_sha256(secret, body));
    let received = sig_header.trim();

    // Try hex comparison first, then base64
    if ct_str_eq(&received.to_lowercase(), &expected_hex) {
        return VerificationResult::Valid;
    }

    use base64::Engine;
    let expected_b64 =
        base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, body));
    if ct_str_eq(received, &expected_b64) {
        return VerificationResult::Valid;
    }

    // Also try stripping common prefixes like sha256=
    let stripped = received
        .strip_prefix("sha256=")
        .or_else(|| received.strip_prefix("SHA256="))
        .unwrap_or(received);
    if ct_str_eq(&stripped.to_lowercase(), &expected_hex) {
        return VerificationResult::Valid;
    }

    let mut err = SignatureError::mismatch(&expected_hex, &received.to_lowercase());
    err.header = Some(header_name.to_string());
    VerificationResult::Invalid(err)
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
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
        let h = headers(&[("x-slack-signature", "v0=abc"), ("x-slack-request-timestamp", "123")]);
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
    fn detect_clerk() {
        let h = headers(&[("svix-id", "msg_123"), ("svix-timestamp", "123"), ("svix-signature", "v1,abc")]);
        assert_eq!(detect_provider(&h), Some("clerk"));
    }

    #[test]
    fn detect_discord() {
        let h = headers(&[("x-signature-ed25519", "abc"), ("x-signature-timestamp", "123")]);
        assert_eq!(detect_provider(&h), Some("discord"));
    }

    #[test]
    fn detect_standard_webhooks() {
        let h = headers(&[("webhook-id", "msg_123"), ("webhook-signature", "v1,abc"), ("webhook-timestamp", "123")]);
        assert_eq!(detect_provider(&h), Some("standard-webhooks"));
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
        let payload = format!("{ts}.{{}}", );
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
        let mut params: Vec<(String, String)> =
            url::form_urlencoded::parse(body).map(|(k, v)| (k.to_string(), v.to_string())).collect();
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
        let sig = hex::encode(hmac_sha1(
            secret.as_bytes(),
            body,
        ));
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
}
