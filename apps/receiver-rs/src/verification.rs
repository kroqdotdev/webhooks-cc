//! Webhook signature verification for 31 providers.
//!
//! Mirrors the SDK's `verify.ts` but in Rust. Each provider has a dedicated
//! function that returns a [`VerificationResult`].

use hmac::{Hmac, KeyInit, Mac};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use sha1::Sha1;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Bound on cached PayPal certificates. The cert URL path suffix is
/// sender-controlled, so an unbounded map keyed by it would be a
/// memory-growth vector. PayPal rotates through very few live certs.
const PAYPAL_CERT_CACHE_MAX: usize = 16;

static PAYPAL_CERT_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PAYPAL_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn paypal_http_client() -> &'static reqwest::Client {
    PAYPAL_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            // No redirects: the allowlist check applies to the original
            // cert URL only, and a redirect must not escape PayPal's hosts.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            // Build only fails when TLS or DNS setup is broken — an
            // unrecoverable environment problem, so fail loudly.
            .expect("failed to build PayPal HTTP client")
    })
}

/// Cache a fetched PayPal certificate. Refuses bodies that do not contain a
/// public key (error pages must not poison the cache) and refuses new keys
/// once the cache is full. Returns whether the certificate was stored.
pub(crate) fn cache_paypal_certificate(cert_url: &str, certificate_pem: &str) -> bool {
    if public_key_der_from_pem(certificate_pem).is_none() {
        return false;
    }
    let Ok(mut cache) = PAYPAL_CERT_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return false;
    };
    if cache.len() >= PAYPAL_CERT_CACHE_MAX && !cache.contains_key(cert_url) {
        return false;
    }
    cache.insert(cert_url.to_string(), certificate_pem.to_string());
    true
}

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
        // Safe for multi-byte UTF-8: find a char boundary before the limit
        let end = s.floor_char_boundary(max.saturating_sub(3));
        format!("{}...", &s[..end])
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

fn hmac_sha256_hex_key(secret_hex: &[u8], payload: &[u8]) -> Result<Vec<u8>, Box<SignatureError>> {
    let key_hex = std::str::from_utf8(secret_hex).map_err(|_| {
        Box::new(SignatureError::invalid_encoding(
            "Adyen HMAC key must be UTF-8 hex",
        ))
    })?;
    let key = hex::decode(key_hex.trim()).map_err(|_| {
        Box::new(SignatureError::invalid_encoding(
            "Adyen HMAC key must be hex encoded",
        ))
    })?;
    Ok(hmac_sha256(&key, payload))
}

fn base64_decode(value: &str) -> Result<Vec<u8>, Box<SignatureError>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| {
            Box::new(SignatureError::invalid_encoding(
                "Expected a base64-encoded value",
            ))
        })
}

fn pem_to_der(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = pem.find(&begin)? + begin.len();
    let finish = pem[start..].find(&end)? + start;
    let body: String = pem[start..finish]
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    base64_decode(&body).ok()
}

#[derive(Clone, Copy)]
struct DerTlv {
    tag: u8,
    start: usize,
    value_start: usize,
    value_end: usize,
    end: usize,
}

fn read_der_tlv(bytes: &[u8], offset: usize) -> Option<DerTlv> {
    if offset >= bytes.len() {
        return None;
    }
    let start = offset;
    let tag = bytes[offset];
    let mut cursor = offset + 1;
    if cursor >= bytes.len() {
        return None;
    }
    let mut length = bytes[cursor] as usize;
    cursor += 1;
    if length & 0x80 != 0 {
        let length_bytes = length & 0x7f;
        if length_bytes == 0 || length_bytes > 4 || cursor + length_bytes > bytes.len() {
            return None;
        }
        length = 0;
        for _ in 0..length_bytes {
            length = (length << 8) | bytes[cursor] as usize;
            cursor += 1;
        }
    }
    let value_start = cursor;
    let value_end = value_start.checked_add(length)?;
    if value_end > bytes.len() {
        return None;
    }
    Some(DerTlv {
        tag,
        start,
        value_start,
        value_end,
        end: value_end,
    })
}

fn subject_public_key_info_from_certificate(cert_der: &[u8]) -> Option<Vec<u8>> {
    let cert = read_der_tlv(cert_der, 0)?;
    if cert.tag != 0x30 {
        return None;
    }
    let tbs = read_der_tlv(cert_der, cert.value_start)?;
    if tbs.tag != 0x30 {
        return None;
    }

    let mut cursor = tbs.value_start;
    let first = read_der_tlv(cert_der, cursor)?;
    if first.tag == 0xa0 {
        cursor = first.end;
    }

    // serialNumber, signature, issuer, validity, subject
    for _ in 0..5 {
        let part = read_der_tlv(cert_der, cursor)?;
        cursor = part.end;
    }

    let spki = read_der_tlv(cert_der, cursor)?;
    if spki.tag != 0x30 {
        return None;
    }
    Some(cert_der[spki.start..spki.end].to_vec())
}

fn public_key_der_from_pem(pem: &str) -> Option<Vec<u8>> {
    if let Some(public_key) = pem_to_der(pem, "PUBLIC KEY") {
        return Some(public_key);
    }
    let cert = pem_to_der(pem, "CERTIFICATE")?;
    subject_public_key_info_from_certificate(&cert)
}

fn rsa_public_key_der_from_spki(spki_der: &[u8]) -> Option<Vec<u8>> {
    let spki = read_der_tlv(spki_der, 0)?;
    if spki.tag != 0x30 {
        return None;
    }
    let algorithm = read_der_tlv(spki_der, spki.value_start)?;
    let public_key = read_der_tlv(spki_der, algorithm.end)?;
    if public_key.tag != 0x03 || public_key.value_start >= public_key.value_end {
        return None;
    }
    // BIT STRING first byte is the unused-bit count. RSA public keys should be
    // byte-aligned, so strip that byte and return the inner RSAPublicKey DER.
    if spki_der[public_key.value_start] != 0 {
        return None;
    }
    Some(spki_der[public_key.value_start + 1..public_key.value_end].to_vec())
}

pub(crate) fn build_paypal_transmission_message(
    body: &[u8],
    transmission_id: &str,
    transmission_time: &str,
    webhook_id: &str,
) -> String {
    let crc = crc32fast::hash(body);
    format!("{transmission_id}|{transmission_time}|{webhook_id}|{crc}")
}

fn is_allowed_paypal_cert_url(cert_url: &str) -> bool {
    let Ok(url) = url::Url::parse(cert_url) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(
        host,
        "api.paypal.com"
            | "api-m.paypal.com"
            | "api.sandbox.paypal.com"
            | "api-m.sandbox.paypal.com"
    ) && url.path().starts_with("/v1/notifications/certs/")
}

/// Verify a webhook signature for the given provider.
///
/// - `provider`: one of the supported provider names (e.g., "stripe", "github").
/// - `secret`: the decrypted signing secret (or public key for Discord).
/// - `headers`: the filtered request headers (lowercase keys from the webhook handler).
/// - `body`: the raw request body bytes.
/// - `signing_header`: custom header name (only used for "generic-hmac" provider).
/// - `request_url`: the full request URL (used by Twilio, Square, and HubSpot, which bind the
///   signature to the URL the webhook was delivered to).
/// - `method`: the HTTP method (used by HubSpot v3, which signs `method + uri + body + timestamp`).
pub fn verify_signature(
    provider: &str,
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    signing_header: Option<&str>,
    request_url: Option<&str>,
    method: Option<&str>,
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
        "typeform" => verify_typeform(secret, headers, body),
        "clerk" => verify_clerk(secret, headers, body),
        "discord" => verify_discord(secret, headers, body),
        "standard-webhooks" => verify_standard_webhooks(secret, headers, body),
        // Meta (WhatsApp/Messenger/Instagram) reuses GitHub's `sha256=` HMAC-SHA256
        // scheme, keyed by the Meta app secret.
        "meta" => verify_github(secret, headers, body),
        "lemonsqueezy" => verify_hex_sha256(secret, headers, body, "x-signature"),
        "coinbase-commerce" => verify_hex_sha256(secret, headers, body, "x-cc-webhook-signature"),
        "razorpay" => verify_hex_sha256(secret, headers, body, "x-razorpay-signature"),
        "cal" => verify_hex_sha256(secret, headers, body, "x-cal-signature-256"),
        "intercom" => verify_intercom(secret, headers, body),
        "telegram" => verify_telegram(secret, headers),
        // ── Tier-2 ──
        "square" => verify_square(secret, headers, body, request_url),
        "hubspot" => verify_hubspot(secret, headers, body, request_url, method),
        // Mailgun signs body fields (no header); it is owner-selected only and
        // is intentionally NOT auto-detected (no distinctive header to key on).
        "mailgun" => verify_mailgun(secret, headers, body),
        // Calendly: Stripe-style `t=,v1=` header, HMAC-SHA256 hex over `{t}.{body}`.
        "calendly" => verify_calendly(secret, headers, body),
        // Mux: same Stripe-style scheme as Calendly with the `mux-signature` header.
        "mux" => verify_mux(secret, headers, body),
        // Sentry: HMAC-SHA256 hex over the raw body in `sentry-hook-signature`.
        "sentry" => verify_hex_sha256(secret, headers, body, "sentry-hook-signature"),
        // Bitbucket: GitHub-style `sha256=` HMAC-SHA256 over the body, but on the
        // legacy `x-hub-signature` header (Intercom uses the same header with
        // `sha1=`; detection keys on the unique `x-event-key` header instead).
        "bitbucket" => verify_github_with_header(secret, headers, body, "x-hub-signature"),
        "docusign" => verify_docusign(secret, headers, body),
        "adyen" => verify_adyen(secret, body),
        "paypal" => VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some(
                "PayPal verification requires certificate fetching; use verify_signature_async."
                    .to_string(),
            ),
        }),
        "plaid" => VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some(
                "Plaid verification requires Plaid JWT/JWK lookup credentials and is not supported yet."
                    .to_string(),
            ),
        }),
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

async fn verify_paypal(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let Some(cert_url) = get_header(headers, "paypal-cert-url") else {
        return VerificationResult::Skipped(SignatureError::missing_header("paypal-cert-url"));
    };
    if !is_allowed_paypal_cert_url(cert_url) {
        return VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: Some(truncate(cert_url, 64)),
            timestamp: None,
            header: Some("paypal-cert-url".to_string()),
            message: Some("PayPal certificate URL must be an official PayPal cert URL".to_string()),
        });
    }

    let cached = PAYPAL_CERT_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(cert_url).cloned());

    let certificate = if let Some(cached) = cached {
        cached
    } else {
        let cert_fetch_failed = |message: String| {
            VerificationResult::Skipped(SignatureError {
                code: "cert_fetch_failed",
                expected: None,
                received: None,
                timestamp: None,
                header: Some("paypal-cert-url".to_string()),
                message: Some(message),
            })
        };
        let response = match paypal_http_client().get(cert_url).send().await {
            Ok(response) => response,
            Err(e) => {
                return cert_fetch_failed(format!("Failed to fetch PayPal certificate: {e}"));
            }
        };
        if !response.status().is_success() {
            return cert_fetch_failed(format!(
                "PayPal certificate fetch returned HTTP {}",
                response.status()
            ));
        }
        let fetched = match response.text().await {
            Ok(text) => text,
            Err(e) => {
                return cert_fetch_failed(format!("Failed to read PayPal certificate: {e}"));
            }
        };
        // Only parseable certificates are cached, so a transient bad response
        // cannot permanently poison verification for this URL.
        cache_paypal_certificate(cert_url, &fetched);
        fetched
    };

    verify_paypal_with_certificate(secret, headers, body, &certificate)
}

pub(crate) fn verify_paypal_with_certificate(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    certificate_pem: &str,
) -> VerificationResult {
    let webhook_id = match std::str::from_utf8(secret) {
        Ok(value) if !value.is_empty() => value,
        _ => {
            return VerificationResult::Skipped(SignatureError {
                code: "missing_secret",
                expected: None,
                received: None,
                timestamp: None,
                header: None,
                message: Some("PayPal verification requires the webhook ID".to_string()),
            });
        }
    };
    let Some(transmission_id) = get_header(headers, "paypal-transmission-id") else {
        return VerificationResult::Skipped(SignatureError::missing_header(
            "paypal-transmission-id",
        ));
    };
    let Some(transmission_time) = get_header(headers, "paypal-transmission-time") else {
        return VerificationResult::Skipped(SignatureError::missing_header(
            "paypal-transmission-time",
        ));
    };
    let Some(cert_url) = get_header(headers, "paypal-cert-url") else {
        return VerificationResult::Skipped(SignatureError::missing_header("paypal-cert-url"));
    };
    let Some(signature_header) = get_header(headers, "paypal-transmission-sig") else {
        return VerificationResult::Skipped(SignatureError::missing_header(
            "paypal-transmission-sig",
        ));
    };
    if !is_allowed_paypal_cert_url(cert_url) {
        return VerificationResult::Skipped(SignatureError {
            code: "unsupported",
            expected: None,
            received: Some(truncate(cert_url, 64)),
            timestamp: None,
            header: Some("paypal-cert-url".to_string()),
            message: Some("PayPal certificate URL must be an official PayPal cert URL".to_string()),
        });
    }
    if let Some(auth_algo) = get_header(headers, "paypal-auth-algo")
        && !auth_algo.eq_ignore_ascii_case("SHA256WITHRSA")
    {
        return VerificationResult::Invalid(SignatureError::invalid_encoding(
            "PayPal paypal-auth-algo must be SHA256withRSA",
        ));
    }

    let signature = match base64_decode(signature_header) {
        Ok(value) => value,
        Err(err) => return VerificationResult::Invalid(*err),
    };
    let Some(public_key_der) = public_key_der_from_pem(certificate_pem) else {
        return VerificationResult::Invalid(SignatureError::invalid_encoding(
            "PayPal certificate did not contain an RSA public key",
        ));
    };
    let message =
        build_paypal_transmission_message(body, transmission_id, transmission_time, webhook_id);
    let public_key = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, public_key_der.as_slice());
    let valid = public_key.verify(message.as_bytes(), &signature).is_ok()
        || rsa_public_key_der_from_spki(&public_key_der)
            .map(|rsa_der| {
                UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, rsa_der)
                    .verify(message.as_bytes(), &signature)
                    .is_ok()
            })
            .unwrap_or(false);
    if valid {
        VerificationResult::Valid
    } else {
        VerificationResult::Invalid(SignatureError {
            code: "mismatch",
            expected: Some("RSA-SHA256 signature over PayPal transmission message".to_string()),
            received: Some(truncate(signature_header, 64)),
            timestamp: None,
            header: Some("paypal-transmission-sig".to_string()),
            message: Some("Computed PayPal signature does not match".to_string()),
        })
    }
}

pub async fn verify_signature_async(
    provider: &str,
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    signing_header: Option<&str>,
    request_url: Option<&str>,
    method: Option<&str>,
) -> VerificationResult {
    match provider {
        "paypal" => verify_paypal(secret, headers, body).await,
        _ => verify_signature(
            provider,
            secret,
            headers,
            body,
            signing_header,
            request_url,
            method,
        ),
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
    if get_header(headers, "x-github-event").is_some()
        || get_header(headers, "x-hub-signature-256").is_some()
    {
        return Some("github");
    }
    if get_header(headers, "x-shopify-hmac-sha256").is_some()
        || get_header(headers, "x-shopify-topic").is_some()
    {
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
    if get_header(headers, "x-docusign-signature-1").is_some() {
        return Some("docusign");
    }
    if get_header(headers, "paypal-transmission-id").is_some()
        && get_header(headers, "paypal-transmission-time").is_some()
        && get_header(headers, "paypal-transmission-sig").is_some()
        && get_header(headers, "paypal-cert-url").is_some()
    {
        return Some("paypal");
    }
    if get_header(headers, "plaid-verification").is_some() {
        return Some("plaid");
    }
    if get_header(headers, "x-vercel-signature").is_some() {
        return Some("vercel");
    }
    if get_header(headers, "x-gitlab-event").is_some()
        || get_header(headers, "x-gitlab-token").is_some()
    {
        return Some("gitlab");
    }
    if get_header(headers, "typeform-signature").is_some() {
        return Some("typeform");
    }
    // Clerk/Svix: check svix-id first (more specific), then webhook-id
    if get_header(headers, "svix-id").is_some() {
        return Some("clerk");
    }
    if get_header(headers, "x-signature-ed25519").is_some()
        && get_header(headers, "x-signature-timestamp").is_some()
    {
        return Some("discord");
    }
    // Standard Webhooks: webhook-id + webhook-signature (must have both)
    if get_header(headers, "webhook-id").is_some()
        && get_header(headers, "webhook-timestamp").is_some()
        && get_header(headers, "webhook-signature").is_some()
    {
        return Some("standard-webhooks");
    }
    // ── Tier-1 providers with distinctive headers ──
    if get_header(headers, "x-cc-webhook-signature").is_some() {
        return Some("coinbase-commerce");
    }
    if get_header(headers, "x-razorpay-signature").is_some() {
        return Some("razorpay");
    }
    if get_header(headers, "x-cal-signature-256").is_some() {
        return Some("cal");
    }
    if get_header(headers, "x-telegram-bot-api-secret-token").is_some() {
        return Some("telegram");
    }
    // ── Tier-2 providers with distinctive headers ──
    if get_header(headers, "x-square-hmacsha256-signature").is_some() {
        return Some("square");
    }
    if get_header(headers, "x-hubspot-signature-v3").is_some() {
        return Some("hubspot");
    }
    if get_header(headers, "calendly-webhook-signature").is_some() {
        return Some("calendly");
    }
    if get_header(headers, "mux-signature").is_some() {
        return Some("mux");
    }
    if get_header(headers, "sentry-hook-signature").is_some() {
        return Some("sentry");
    }
    // Bitbucket: shares the legacy `x-hub-signature` header with Intercom but
    // uses the GitHub-style `sha256=` scheme. It carries a unique `x-event-key`
    // header, so we detect on that and MUST check it BEFORE Intercom to avoid the
    // shared-header collision.
    if get_header(headers, "x-event-key").is_some() {
        return Some("bitbucket");
    }
    // Intercom: legacy `x-hub-signature` with a `sha1=` prefix. Checked AFTER
    // GitHub (which sends the same header alongside x-hub-signature-256 +
    // x-github-event) so GitHub webhooks never mis-detect as Intercom, and after
    // Bitbucket (x-event-key + sha256=); the sha1= prefix disambiguates from
    // Bitbucket's sha256= form.
    if get_header(headers, "x-hub-signature")
        .map(|v| v.trim().to_lowercase().starts_with("sha1="))
        .unwrap_or(false)
    {
        return Some("intercom");
    }
    // Note: Meta (shares x-hub-signature-256 with GitHub) and Lemon Squeezy
    // (generic x-signature) are owner-selected only — they are intentionally
    // not auto-detected here to avoid colliding with GitHub / other providers.
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
    verify_github_with_header(secret, headers, body, "x-hub-signature-256")
}

/// GitHub-style `sha256={hex}` HMAC-SHA256 over the raw body, reading an
/// arbitrary header. GitHub/Meta use `x-hub-signature-256`; Bitbucket uses the
/// legacy `x-hub-signature` header with the same `sha256=` scheme (a `sha1=`
/// Intercom signature on the same header lacks the prefix and is rejected).
fn verify_github_with_header(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    header_name: &str,
) -> VerificationResult {
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header.trim();
    let hex_sig = match received.strip_prefix("sha256=") {
        Some(h) => h,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(&format!(
                "Expected sha256= prefix on {header_name}"
            )));
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

/// Docusign Connect: HMAC-SHA256 over the raw body, base64 encoded in
/// `x-docusign-signature-1`.
fn verify_docusign(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    use base64::Engine;
    let header_name = "x-docusign-signature-1";
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

    let expected =
        base64::engine::general_purpose::STANDARD.encode(hmac_sha1(secret, payload.as_bytes()));
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

/// Typeform: HMAC-SHA256 over the raw JSON body, base64 encoded with sha256= prefix.
fn verify_typeform(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    use base64::Engine;
    let header_name = "typeform-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header
        .trim()
        .strip_prefix("sha256=")
        .unwrap_or(sig_header.trim());

    if received.is_empty() {
        return VerificationResult::Invalid(SignatureError::invalid_encoding(
            "Expected sha256={base64} in typeform-signature",
        ));
    }

    let expected = base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, body));

    if ct_str_eq(received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, received);
        err.header = Some(header_name.to_string());
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
        && get_header(headers, "webhook-id").is_none()
    {
        normalized.insert("webhook-id".to_string(), id.to_string());
    }
    if let Some(ts) = get_header(headers, "svix-timestamp")
        && get_header(headers, "webhook-timestamp").is_none()
    {
        normalized.insert("webhook-timestamp".to_string(), ts.to_string());
    }
    if let Some(sig) = get_header(headers, "svix-signature")
        && get_header(headers, "webhook-signature").is_none()
    {
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

    let pk_array: [u8; 32] = match pk_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(&format!(
                "Ed25519 public key must be 32 bytes, got {}",
                pk_bytes.len()
            )));
        }
    };
    let verifying_key = match ed25519_dalek::VerifyingKey::from_bytes(&pk_array) {
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

    let payload = format!("{msg_id}.{timestamp}.{}", String::from_utf8_lossy(body));
    let expected = base64::engine::general_purpose::STANDARD
        .encode(hmac_sha256(&key_bytes, payload.as_bytes()));

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
            && !sig.is_empty()
        {
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
    let expected_b64 = base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, body));
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

/// Raw hex HMAC-SHA256 over the body, sent in a provider-specific header.
/// Accepts an optional `prefix=` form (e.g. `sha256=...`) for parity with the
/// SDK helper. Shared by Lemon Squeezy, Coinbase Commerce, Razorpay, and Cal.com.
fn verify_hex_sha256(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    header_name: &'static str,
) -> VerificationResult {
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header.trim();
    // Take the part after the first `=` when a `prefix=` form is used; otherwise
    // treat the entire value as the hex signature.
    let hex_sig = match received.split_once('=') {
        Some((_, rest)) => rest,
        None => received,
    };
    if hex_sig.is_empty() {
        return VerificationResult::Invalid(SignatureError::invalid_encoding(&format!(
            "Empty signature in {header_name}"
        )));
    }

    let expected = hex::encode(hmac_sha256(secret, body));
    if ct_str_eq(&hex_sig.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &hex_sig.to_lowercase());
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Intercom: HMAC-SHA1 over the body, header is `sha1={hex}`.
fn verify_intercom(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "x-hub-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let received = sig_header.trim();
    let hex_sig = match received.strip_prefix("sha1=") {
        Some(h) => h,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Expected sha1= prefix on x-hub-signature",
            ));
        }
    };

    let expected = hex::encode(hmac_sha1(secret, body));
    if ct_str_eq(&hex_sig.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &hex_sig.to_lowercase());
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Telegram: constant-time comparison of the secret token (no HMAC).
fn verify_telegram(secret: &[u8], headers: &HashMap<String, String>) -> VerificationResult {
    let header_name = "x-telegram-bot-api-secret-token";
    let Some(token) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    if ct_eq(token.as_bytes(), secret) {
        VerificationResult::Valid
    } else {
        let err = SignatureError {
            code: "mismatch",
            expected: None,                     // Don't leak the expected token
            received: Some(truncate(token, 8)), // Show first 8 chars only
            timestamp: None,
            header: Some(header_name.to_string()),
            message: Some("Token does not match".to_string()),
        };
        VerificationResult::Invalid(err)
    }
}

/// Square: HMAC-SHA256 over `notificationURL + rawBody`, base64 encoded, sent in
/// `x-square-hmacsha256-signature`. The signature is bound to the exact
/// notification URL, so the request URL must be available.
fn verify_square(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    request_url: Option<&str>,
) -> VerificationResult {
    use base64::Engine;
    let header_name = "x-square-hmacsha256-signature";
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
            message: Some("Square verification requires the request URL".to_string()),
        });
    };

    // Payload is the notification URL concatenated with the raw body bytes.
    let mut payload = url.as_bytes().to_vec();
    payload.extend_from_slice(body);

    let expected = base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, &payload));
    let received = sig_header.trim();

    if ct_str_eq(received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, received);
        err.header = Some(header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Maximum age of a HubSpot v3 timestamp before the request is rejected (replay
/// protection). HubSpot recommends 5 minutes.
const HUBSPOT_MAX_AGE_MS: i64 = 5 * 60 * 1000;

/// HubSpot v3: base64 HMAC-SHA256 over `requestMethod + requestUri + rawBody +
/// timestamp`, sent in `x-hubspot-signature-v3` with the request timestamp (in
/// milliseconds) in `x-hubspot-request-timestamp`. The signature is bound to the
/// exact method and URI, so both must be available. Timestamps older than
/// `HUBSPOT_MAX_AGE_MS` are rejected to defeat replay attacks.
fn verify_hubspot(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
    request_url: Option<&str>,
    method: Option<&str>,
) -> VerificationResult {
    use base64::Engine;
    let sig_header_name = "x-hubspot-signature-v3";
    let ts_header_name = "x-hubspot-request-timestamp";

    let Some(sig_header) = get_header(headers, sig_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(sig_header_name));
    };
    let Some(timestamp) = get_header(headers, ts_header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(ts_header_name));
    };
    let Some(url) = request_url else {
        return VerificationResult::Skipped(SignatureError {
            code: "missing_header",
            expected: None,
            received: None,
            timestamp: None,
            header: None,
            message: Some("HubSpot verification requires the request URL".to_string()),
        });
    };
    let method = method.unwrap_or("POST").to_uppercase();

    // Timestamp must be a valid integer (epoch milliseconds).
    let ts_ms = match timestamp.trim().parse::<i64>() {
        Ok(v) => v,
        Err(_) => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "x-hubspot-request-timestamp is not a valid integer",
            ));
        }
    };

    // Reject stale timestamps (replay protection).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if (now_ms - ts_ms).abs() > HUBSPOT_MAX_AGE_MS {
        let mut err = SignatureError {
            code: "timestamp_expired",
            expected: None,
            received: None,
            timestamp: Some(ts_ms),
            header: Some(ts_header_name.to_string()),
            message: Some("HubSpot timestamp is outside the 5-minute freshness window".to_string()),
        };
        err.received = Some(truncate(sig_header.trim(), 64));
        return VerificationResult::Invalid(err);
    }

    // Signed payload: method + uri + raw body + timestamp. HubSpot decodes a
    // documented set of reserved percent-encoded characters in the URI before
    // signing, so apply the same map to match signatures for URLs containing them.
    let decoded_uri = decode_hubspot_uri(url);
    let mut payload = Vec::new();
    payload.extend_from_slice(method.as_bytes());
    payload.extend_from_slice(decoded_uri.as_bytes());
    payload.extend_from_slice(body);
    payload.extend_from_slice(timestamp.as_bytes());

    let expected = base64::engine::general_purpose::STANDARD.encode(hmac_sha256(secret, &payload));
    let received = sig_header.trim();

    if ct_str_eq(received, &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, received);
        err.timestamp = Some(ts_ms);
        err.header = Some(sig_header_name.to_string());
        VerificationResult::Invalid(err)
    }
}

/// Decode the reserved percent-encoded characters that HubSpot v3 normalizes in
/// the request URI before signing (`method + uri + body + timestamp`). The `?`
/// query separator is intentionally left untouched, and none of the decoded
/// characters is `%`, so a single left-to-right replacement pass cannot create a
/// new escape sequence. Matching is case-sensitive on the uppercase encodings
/// HubSpot emits (RFC 3986 recommends uppercase hex).
///
/// See: https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests
fn decode_hubspot_uri(uri: &str) -> String {
    const REPLACEMENTS: &[(&str, &str)] = &[
        ("%3A", ":"),
        ("%2F", "/"),
        ("%3F", "?"),
        ("%40", "@"),
        ("%21", "!"),
        ("%24", "$"),
        ("%27", "'"),
        ("%28", "("),
        ("%29", ")"),
        ("%2A", "*"),
        ("%2C", ","),
        ("%3B", ";"),
    ];
    let mut decoded = uri.to_string();
    for (encoded, plain) in REPLACEMENTS {
        if decoded.contains(encoded) {
            decoded = decoded.replace(encoded, plain);
        }
    }
    decoded
}

fn adyen_field(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn adyen_data_to_sign(item: &serde_json::Value) -> String {
    [
        adyen_field(item.get("pspReference")),
        adyen_field(item.get("originalReference")),
        adyen_field(item.get("merchantAccountCode")),
        adyen_field(item.get("merchantReference")),
        adyen_field(item.get("amount").and_then(|amount| amount.get("value"))),
        adyen_field(item.get("amount").and_then(|amount| amount.get("currency"))),
        adyen_field(item.get("eventCode")),
        adyen_field(item.get("success")),
    ]
    .join(":")
}

/// Adyen standard notifications: base64(HMAC-SHA256(hex_key, signed fields))
/// stored at `additionalData.hmacSignature` inside each notification item.
fn verify_adyen(secret: &[u8], body: &[u8]) -> VerificationResult {
    use base64::Engine;
    let parsed: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return VerificationResult::Skipped(SignatureError {
                code: "missing_header",
                expected: None,
                received: None,
                timestamp: None,
                header: None,
                message: Some("Adyen body is not valid JSON".to_string()),
            });
        }
    };

    let Some(items) = parsed
        .get("notificationItems")
        .and_then(|items| items.as_array())
    else {
        return VerificationResult::Skipped(SignatureError {
            code: "missing_header",
            expected: None,
            received: None,
            timestamp: None,
            header: Some("notificationItems".to_string()),
            message: Some("Adyen body is missing notificationItems".to_string()),
        });
    };

    // Every notification item must carry its own valid signature: one genuine
    // item must not vouch for forged or unsigned siblings in the same batch.
    let mut signed_items = 0usize;
    let mut unsigned_items = 0usize;
    for notification in items {
        let Some(item) = notification.get("NotificationRequestItem") else {
            continue;
        };
        let Some(signature) = item
            .get("additionalData")
            .and_then(|data| data.get("hmacSignature"))
            .and_then(|sig| sig.as_str())
        else {
            unsigned_items += 1;
            continue;
        };
        signed_items += 1;
        let payload = adyen_data_to_sign(item);
        let expected = match hmac_sha256_hex_key(secret, payload.as_bytes()) {
            Ok(mac) => base64::engine::general_purpose::STANDARD.encode(mac),
            Err(err) => return VerificationResult::Invalid(*err),
        };
        if !ct_str_eq(signature, &expected) {
            let mut err = SignatureError::mismatch(&expected, signature);
            err.header = Some("additionalData.hmacSignature".to_string());
            return VerificationResult::Invalid(err);
        }
    }

    if signed_items == 0 {
        return VerificationResult::Skipped(SignatureError {
            code: "missing_header",
            expected: None,
            received: None,
            timestamp: None,
            header: Some("additionalData.hmacSignature".to_string()),
            message: Some("Adyen body is missing additionalData.hmacSignature".to_string()),
        });
    }

    if unsigned_items > 0 {
        return VerificationResult::Invalid(SignatureError {
            code: "mismatch",
            expected: None,
            received: None,
            timestamp: None,
            header: Some("additionalData.hmacSignature".to_string()),
            message: Some(format!(
                "Adyen batch contains {unsigned_items} notification item(s) without an hmacSignature"
            )),
        });
    }

    VerificationResult::Valid
}

/// Mailgun: HMAC-SHA256 hex over `timestamp + token`. Unlike every other
/// provider, Mailgun does not send a signature header — the `timestamp`,
/// `token`, and `signature` fields live inside the JSON body under `signature`.
/// Malformed/non-JSON bodies, or bodies missing the signature fields, are
/// `Skipped` (this function never panics on bad input).
fn verify_mailgun(
    secret: &[u8],
    _headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let parsed: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            return VerificationResult::Skipped(SignatureError {
                code: "missing_header",
                expected: None,
                received: None,
                timestamp: None,
                header: None,
                message: Some("Mailgun body is not valid JSON".to_string()),
            });
        }
    };

    let sig = &parsed["signature"];
    let (timestamp, token, signature) = match (
        sig["timestamp"].as_str(),
        sig["token"].as_str(),
        sig["signature"].as_str(),
    ) {
        (Some(ts), Some(tok), Some(s)) if !ts.is_empty() && !tok.is_empty() && !s.is_empty() => {
            (ts, tok, s)
        }
        _ => {
            return VerificationResult::Skipped(SignatureError {
                code: "missing_header",
                expected: None,
                received: None,
                timestamp: None,
                header: Some("signature".to_string()),
                message: Some(
                    "Mailgun body is missing signature.{timestamp,token,signature}".to_string(),
                ),
            });
        }
    };

    let payload = format!("{timestamp}{token}");
    let expected = hex::encode(hmac_sha256(secret, payload.as_bytes()));

    if ct_str_eq(&signature.to_lowercase(), &expected) {
        VerificationResult::Valid
    } else {
        let mut err = SignatureError::mismatch(&expected, &signature.to_lowercase());
        err.timestamp = timestamp.parse::<i64>().ok();
        err.header = Some("signature".to_string());
        VerificationResult::Invalid(err)
    }
}

/// Calendly: Stripe-style `calendly-webhook-signature` header (`t=...,v1=...`),
/// HMAC-SHA256 hex over `{timestamp}.{body}`. Reuses the shared Stripe parser.
fn verify_calendly(
    secret: &[u8],
    headers: &HashMap<String, String>,
    body: &[u8],
) -> VerificationResult {
    let header_name = "calendly-webhook-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let (timestamp, signatures) = match parse_stripe_header(sig_header) {
        Some(v) => v,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not parse calendly-webhook-signature header (expected t=...,v1=...)",
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

/// Mux: same Stripe-style scheme as Calendly (`t=...,v1=...`), HMAC-SHA256 hex
/// over `{timestamp}.{body}`, carried in the `mux-signature` header.
fn verify_mux(secret: &[u8], headers: &HashMap<String, String>, body: &[u8]) -> VerificationResult {
    let header_name = "mux-signature";
    let Some(sig_header) = get_header(headers, header_name) else {
        return VerificationResult::Skipped(SignatureError::missing_header(header_name));
    };

    let (timestamp, signatures) = match parse_stripe_header(sig_header) {
        Some(v) => v,
        None => {
            return VerificationResult::Invalid(SignatureError::invalid_encoding(
                "Could not parse mux-signature header (expected t=...,v1=...)",
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

#[cfg(test)]
#[path = "tests/verification_tests.rs"]
mod tests;
