use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;
use std::time::Instant;

use crate::api::ApiClient;
use crate::types::{CapturedRequest, EmailFormat, ForwardResult, RenderedEmail};
use crate::util::body::resolve_body;

/// Headers that are always stripped from forwarded requests (security + hop-by-hop).
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "content-length",
    "cookie",
    "set-cookie",
    "x-api-key",
    "proxy-authorization",
    "x-auth-token",
    "x-access-token",
];

/// Proxy/infrastructure headers stripped to avoid duplication.
const PROXY_HEADERS: &[&str] = &[
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cf-warp-tag-id",
    "true-client-ip",
    "via",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-forwarded-scheme",
    "x-real-ip",
];

/// Shown when a captured email reaches a tunnel that skips emails (`--no-email`).
pub const EMAIL_SKIPPED: &str = "skipped (--no-email)";

/// How the tunnel delivers captured emails. An email is a message sent to an
/// address, not an HTTP request, so the API renders it first (as webhooks.cc's
/// email JSON or the way a mail provider posts it) and the tunnel posts that.
#[derive(Clone, Default)]
pub struct EmailOptions {
    pub format: EmailFormat,
    /// Appended to the target like a webhook's path; `None` posts to the target itself.
    pub path: Option<String>,
    /// Signs the Mailgun form; sent to the API only with `EmailFormat::Mailgun`.
    pub mailgun_signing_key: Option<String>,
}

impl std::fmt::Debug for EmailOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailOptions")
            .field("format", &self.format)
            .field("path", &self.path)
            .field(
                "mailgun_signing_key",
                &self.mailgun_signing_key.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl EmailOptions {
    /// The key to render with: only a Mailgun form is signed.
    pub fn signing_key(&self) -> Option<&str> {
        self.mailgun_signing_key
            .as_deref()
            .filter(|key| self.format == EmailFormat::Mailgun && !key.is_empty())
    }
}

pub struct Tunnel {
    http: reqwest::Client,
    target_base: String,
    extra_headers: HashMap<String, String>,
    /// The client that renders emails and how to post them; `None` skips emails.
    emails: Option<(ApiClient, EmailOptions)>,
}

impl Tunnel {
    pub fn new(target_base: String, extra_headers: HashMap<String, String>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(Self {
            http,
            target_base,
            extra_headers,
            emails: None,
        })
    }

    /// Deliver captured emails too, rendered through `client` as `options`
    /// say. Without this the tunnel skips them.
    pub fn with_emails(mut self, client: ApiClient, options: EmailOptions) -> Self {
        self.emails = Some((client, options));
        self
    }

    /// Forward a captured request to the local target. Returns the result.
    pub async fn forward(&self, req: &CapturedRequest) -> ForwardResult {
        if req.is_email() {
            return self.forward_email(req).await;
        }

        let start = Instant::now();
        let target_url = build_target_url(&self.target_base, &req.path, &req.query_params);

        let method: reqwest::Method = req
            .method
            .parse()
            .unwrap_or(reqwest::Method::GET);

        let mut headers = HeaderMap::new();
        for (key, value) in &req.headers {
            let lower = key.to_lowercase();
            if should_filter_header(&lower) {
                continue;
            }
            insert_header(&mut headers, key, value);
        }

        // Add extra user-specified headers
        for (key, value) in &self.extra_headers {
            insert_header(&mut headers, key, value);
        }

        // Inject signature verification headers when verification was performed
        if let Some(verified) = req.signature_verified {
            if let Ok(val) = HeaderValue::from_str(if verified { "true" } else { "false" }) {
                headers.insert(
                    HeaderName::from_static("x-signature-verified"),
                    val,
                );
            }
            if let Some(ref provider) = req.signing_provider
                && let Ok(val) = HeaderValue::from_str(provider) {
                    headers.insert(
                        HeaderName::from_static("x-signature-provider"),
                        val,
                    );
                }
            if !verified
                && let Some(ref error) = req.signature_error {
                    // Extract just the error code from JSON (e.g., "mismatch") since
                    // full JSON contains chars invalid in HTTP header values
                    let code = serde_json::from_str::<serde_json::Value>(error)
                        .ok()
                        .and_then(|v| v.get("code").and_then(|c| c.as_str().map(String::from)))
                        .unwrap_or_else(|| "unknown".to_string());
                    if let Ok(val) = HeaderValue::from_str(&code) {
                        headers.insert(
                            HeaderName::from_static("x-signature-error"),
                            val,
                        );
                    }
                }
        }

        let mut builder = self.http.request(method, &target_url).headers(headers);

        if let Some(bytes) = resolve_body(req.body_raw.as_deref(), req.body.as_deref()) {
            builder = builder.body(bytes);
        }

        finish(start, builder.send().await).await
    }

    /// Render a captured email through the API and post it to the target.
    async fn forward_email(&self, req: &CapturedRequest) -> ForwardResult {
        let Some((client, options)) = &self.emails else {
            return failed(Instant::now(), EMAIL_SKIPPED.to_string());
        };
        let start = Instant::now();
        let rendered = match client
            .render_email(&req.id, options.format, options.signing_key())
            .await
        {
            Ok(rendered) => rendered,
            Err(e) => return failed(start, format!("could not render the email: {e:#}")),
        };
        // The duration shown is the local server's, as for HTTP requests.
        let start = Instant::now();
        match self.email_request(options, &rendered) {
            Ok(request) => finish(start, self.http.execute(request).await).await,
            Err(e) => failed(start, e.to_string()),
        }
    }

    /// The request that posts a rendered email: its method and body, the
    /// content type and user agent the API gave, then the `-H` headers, which
    /// win as they do for HTTP requests.
    pub fn email_request(
        &self,
        options: &EmailOptions,
        rendered: &RenderedEmail,
    ) -> reqwest::Result<reqwest::Request> {
        let method = rendered.method.parse().unwrap_or(reqwest::Method::POST);
        let mut headers = HeaderMap::new();
        for (key, value) in &rendered.headers {
            if !should_filter_header(&key.to_lowercase()) {
                insert_header(&mut headers, key, value);
            }
        }
        for (key, value) in &self.extra_headers {
            insert_header(&mut headers, key, value);
        }
        let url = email_target_url(&self.target_base, options.path.as_deref());
        self.http
            .request(method, url)
            .headers(headers)
            .body(rendered.body.clone())
            .build()
    }
}

/// Where emails go: the target itself, or `path` appended to it like a
/// webhook's path. An email has no path of its own (its `path` is the
/// recipient address).
pub fn email_target_url(base: &str, path: Option<&str>) -> String {
    match path {
        Some(path) => join_path(base, path),
        None => base.to_string(),
    }
}

fn insert_header(headers: &mut HeaderMap, key: &str, value: &str) {
    if let (Ok(name), Ok(val)) = (
        HeaderName::from_bytes(key.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, val);
    }
}

fn failed(start: Instant, error: String) -> ForwardResult {
    ForwardResult {
        success: false,
        status_code: None,
        duration: start.elapsed(),
        error: Some(error),
    }
}

async fn finish(start: Instant, response: reqwest::Result<reqwest::Response>) -> ForwardResult {
    match response {
        Ok(resp) => {
            let status_code = resp.status().as_u16();
            let _ = resp.bytes().await; // consume body
            ForwardResult {
                success: true,
                status_code: Some(status_code),
                duration: start.elapsed(),
                error: None,
            }
        }
        Err(e) => failed(start, e.to_string()),
    }
}

fn should_filter_header(lower: &str) -> bool {
    if SENSITIVE_HEADERS.contains(&lower) {
        return true;
    }
    for prefix in PROXY_HEADERS {
        if lower == *prefix || lower.starts_with(&format!("{prefix}-")) {
            return true;
        }
    }
    // Also filter cf-* headers
    if lower.starts_with("cf-") {
        return true;
    }
    false
}

fn build_target_url(
    base: &str,
    path: &str,
    query_params: &HashMap<String, String>,
) -> String {
    let mut url = join_path(base, path);
    if !query_params.is_empty() {
        let qs: Vec<String> = query_params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
            .collect();
        url.push('?');
        url.push_str(&qs.join("&"));
    }
    url
}

/// Appends a captured path to the target base. A path without a leading slash
/// gets one, so it can never become part of the host: `http://localhost:8080`
/// followed by `user@example.com` would otherwise send the request to
/// example.com.
pub fn join_path(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    if path.is_empty() || path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// Parse a target string like "8080" or "8080/api/webhooks" into (url, base_path).
pub fn parse_target(target: &str) -> Result<String> {
    let (port_str, path) = match target.find('/') {
        Some(pos) => (&target[..pos], &target[pos..]),
        None => (target, ""),
    };

    let port: u16 = port_str
        .parse()
        .context("invalid port number (must be 1-65535)")?;

    if port == 0 {
        anyhow::bail!("port must be between 1 and 65535");
    }

    let base = if path.is_empty() {
        format!("http://localhost:{port}")
    } else {
        format!("http://localhost:{port}{path}")
    };

    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_target_port_only() {
        assert_eq!(parse_target("8080").unwrap(), "http://localhost:8080");
    }

    #[test]
    fn test_parse_target_with_path() {
        assert_eq!(
            parse_target("3000/api/webhooks").unwrap(),
            "http://localhost:3000/api/webhooks"
        );
    }

    #[test]
    fn test_parse_target_invalid() {
        assert!(parse_target("abc").is_err());
        assert!(parse_target("0").is_err());
    }

    #[test]
    fn test_should_filter_header() {
        assert!(should_filter_header("authorization"));
        assert!(should_filter_header("cookie"));
        assert!(should_filter_header("cf-ray"));
        assert!(should_filter_header("cf-connecting-ip"));
        assert!(should_filter_header("x-forwarded-for"));
        assert!(!should_filter_header("content-type"));
        assert!(!should_filter_header("x-custom-header"));
    }

    #[test]
    fn test_build_target_url() {
        let params = HashMap::new();
        assert_eq!(
            build_target_url("http://localhost:8080", "/hook", &params),
            "http://localhost:8080/hook"
        );

        let mut params = HashMap::new();
        params.insert("key".into(), "val".into());
        let url = build_target_url("http://localhost:8080", "/hook", &params);
        assert!(url.contains("key=val"));
    }

    #[test]
    fn test_build_target_url_keeps_the_host_for_paths_without_a_slash() {
        let params = HashMap::new();
        let url = build_target_url("http://localhost:8080", "acme+run@mailhooks.cc", &params);
        assert_eq!(url, "http://localhost:8080/acme+run@mailhooks.cc");
        assert_eq!(
            reqwest::Url::parse(&url).unwrap().host_str(),
            Some("localhost")
        );
        assert_eq!(join_path("http://localhost:8080/", ""), "http://localhost:8080");
        assert_eq!(join_path("http://localhost:8080/api", "/hook"), "http://localhost:8080/api/hook");
    }

    #[test]
    fn test_build_target_url_encodes_special_chars() {
        let mut params = HashMap::new();
        params.insert("q".into(), "hello world&more".into());
        let url = build_target_url("http://localhost:8080", "/hook", &params);
        assert!(url.contains("hello%20world%26more"), "URL should encode special chars: {url}");
    }

    #[test]
    fn test_parse_target_large_port() {
        assert_eq!(parse_target("65535").unwrap(), "http://localhost:65535");
        assert!(parse_target("65536").is_err());
    }

    #[test]
    fn test_filter_all_sensitive_headers() {
        for h in &["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization", "x-auth-token", "x-access-token"] {
            assert!(should_filter_header(h), "should filter: {h}");
        }
    }

    #[test]
    fn test_filter_all_proxy_headers() {
        for h in &["cdn-loop", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "via", "true-client-ip"] {
            assert!(should_filter_header(h), "should filter: {h}");
        }
    }

    #[test]
    fn test_passthrough_normal_headers() {
        for h in &["content-type", "accept", "x-custom-header", "user-agent", "x-request-id"] {
            assert!(!should_filter_header(h), "should pass through: {h}");
        }
    }
}

#[cfg(test)]
mod email_tests {
    use super::*;

    fn rendered(content_type: &str, body: &str) -> RenderedEmail {
        let mut headers = HashMap::new();
        headers.insert("content-type".into(), content_type.into());
        headers.insert(
            "user-agent".into(),
            "webhooks.cc (+https://webhooks.cc/docs/forwarding)".into(),
        );
        RenderedEmail {
            format: "json".into(),
            method: "POST".into(),
            headers,
            body: body.into(),
        }
    }

    #[test]
    fn email_request_posts_the_rendered_body_to_the_target_itself() {
        let tunnel = Tunnel::new("http://localhost:3000/api/email".into(), HashMap::new()).unwrap();
        let rendered = rendered("application/json", r#"{"type":"email.received"}"#);
        let request = tunnel
            .email_request(&EmailOptions::default(), &rendered)
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().as_str(), "http://localhost:3000/api/email");
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(
            request.headers()["user-agent"],
            "webhooks.cc (+https://webhooks.cc/docs/forwarding)"
        );
        assert_eq!(
            request.body().and_then(|b| b.as_bytes()),
            Some(rendered.body.as_bytes())
        );
    }

    #[test]
    fn email_request_keeps_the_boundary_and_lets_extra_headers_win() {
        let mut extra = HashMap::new();
        extra.insert("X-Acme-Env".into(), "dev".into());
        extra.insert("User-Agent".into(), "acme-tests".into());
        let tunnel = Tunnel::new("http://localhost:3000".into(), extra).unwrap();
        let mut rendered = rendered("multipart/form-data; boundary=acme42", "--acme42\r\n");
        rendered.method = String::new();
        rendered
            .headers
            .insert("authorization".into(), "Bearer x".into());
        let options = EmailOptions {
            format: EmailFormat::Sendgrid,
            path: Some("inbound/sendgrid".into()),
            mailgun_signing_key: None,
        };
        let request = tunnel.email_request(&options, &rendered).unwrap();
        assert_eq!(
            request.method(),
            reqwest::Method::POST,
            "no method means POST"
        );
        assert_eq!(
            request.url().as_str(),
            "http://localhost:3000/inbound/sendgrid"
        );
        assert_eq!(
            request.headers()["content-type"],
            "multipart/form-data; boundary=acme42"
        );
        assert_eq!(request.headers()["user-agent"], "acme-tests");
        assert_eq!(request.headers()["x-acme-env"], "dev");
        assert!(request.headers().get("authorization").is_none());
    }

    #[test]
    fn email_target_url_appends_a_path_like_a_webhooks() {
        assert_eq!(
            email_target_url("http://localhost:8080", None),
            "http://localhost:8080"
        );
        assert_eq!(
            email_target_url("http://localhost:8080/api", Some("/inbound")),
            "http://localhost:8080/api/inbound"
        );
        assert_eq!(
            email_target_url("http://localhost:8080", Some("inbound")),
            "http://localhost:8080/inbound"
        );
    }

    #[test]
    fn only_a_mailgun_form_is_signed() {
        let mut options = EmailOptions {
            format: EmailFormat::Mailgun,
            path: None,
            mailgun_signing_key: Some("key-acme".into()),
        };
        assert_eq!(options.signing_key(), Some("key-acme"));
        options.format = EmailFormat::Postmark;
        assert_eq!(options.signing_key(), None);
        options.format = EmailFormat::Mailgun;
        options.mailgun_signing_key = Some(String::new());
        assert_eq!(options.signing_key(), None);
    }

    #[test]
    fn email_options_debug_redacts_the_signing_key() {
        let options = EmailOptions {
            format: EmailFormat::Mailgun,
            path: None,
            mailgun_signing_key: Some("key-acme-secret".into()),
        };
        let debug = format!("{options:?}");
        assert!(!debug.contains("key-acme-secret"), "{debug}");
        assert!(debug.contains("[REDACTED]"));
    }
}

/// End-to-end: a fake API renders the email, a fake local server receives it.
#[cfg(test)]
mod email_live_tests {
    use super::*;
    use axum::Json;
    use axum::Router;
    use axum::extract::{Path, Request, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use std::sync::{Arc, Mutex};

    struct Delivery {
        method: String,
        path: String,
        headers: axum::http::HeaderMap,
        body: String,
    }

    #[derive(Default)]
    struct Seen {
        /// Each render call: the request id, its Authorization header and its body.
        renders: Vec<(String, Option<String>, serde_json::Value)>,
        deliveries: Vec<Delivery>,
    }

    type Shared = Arc<Mutex<Seen>>;

    async fn render(
        State(seen): State<Shared>,
        Path(id): Path<String>,
        headers: axum::http::HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Response {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        seen.lock()
            .unwrap()
            .renders
            .push((id.clone(), auth, body.clone()));
        if id == "gone" {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "not_found" })),
            )
                .into_response();
        }
        let format = body["format"].as_str().unwrap_or("").to_string();
        let content_type = match format.as_str() {
            "mailgun" => "application/x-www-form-urlencoded",
            "sendgrid" => "multipart/form-data; boundary=acme42",
            _ => "application/json",
        };
        Json(serde_json::json!({
            "format": format,
            "method": "POST",
            "headers": {
                "content-type": content_type,
                "user-agent": "webhooks.cc (+https://webhooks.cc/docs/forwarding)",
            },
            "body": format!("{id} as {format}"),
        }))
        .into_response()
    }

    async fn local_target(State(seen): State<Shared>, request: Request) -> StatusCode {
        let (parts, body) = request.into_parts();
        let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
        seen.lock().unwrap().deliveries.push(Delivery {
            method: parts.method.to_string(),
            path: parts.uri.path().to_string(),
            headers: parts.headers,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        });
        StatusCode::ACCEPTED
    }

    /// One server for both: the API under /api, the local target everywhere else.
    async fn start_server() -> (String, Shared) {
        let seen = Shared::default();
        let app = Router::new()
            .route("/api/requests/{id}/render", post(render))
            .fallback(local_target)
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://127.0.0.1:{}", addr.port()), seen)
    }

    fn client(base: &str) -> ApiClient {
        let mut client = ApiClient::new(Some(base), Some(base)).unwrap();
        client.set_token("test-token".into());
        client
    }

    /// As the stream delivers an email: kind set, the recipient as the path.
    fn email(id: &str) -> CapturedRequest {
        let json = format!(
            r#"{{"_id":"{id}","endpointId":"ep","method":"EMAIL","path":"acme+run@mailhooks.cc","headers":{{"subject":"Your code"}},"body":"Subject: Your code\r\n\r\nYour code is 482913","queryParams":{{}},"ip":"192.0.2.1","size":48,"receivedAt":1,"kind":"email"}}"#
        );
        serde_json::from_str(&json).unwrap()
    }

    #[tokio::test]
    async fn posts_an_email_as_json_to_the_target_by_default() {
        let (base, seen) = start_server().await;
        let mut extra = HashMap::new();
        extra.insert("X-Acme-Env".into(), "dev".into());
        let tunnel = Tunnel::new(format!("{base}/hooks/email"), extra)
            .unwrap()
            .with_emails(client(&base), EmailOptions::default());

        let result = tunnel.forward(&email("e1")).await;
        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.status_code, Some(202));

        let seen = seen.lock().unwrap();
        let (id, auth, body) = &seen.renders[0];
        assert_eq!(id, "e1");
        assert_eq!(auth.as_deref(), Some("Bearer test-token"));
        assert_eq!(body, &serde_json::json!({ "format": "json" }));

        let delivery = &seen.deliveries[0];
        assert_eq!(delivery.method, "POST");
        assert_eq!(delivery.path, "/hooks/email");
        assert_eq!(delivery.headers["content-type"], "application/json");
        assert_eq!(delivery.headers["x-acme-env"], "dev");
        assert_eq!(delivery.body, "e1 as json");
    }

    #[tokio::test]
    async fn sends_the_mailgun_key_only_for_mailgun() {
        let (base, seen) = start_server().await;
        let options = EmailOptions {
            format: EmailFormat::Mailgun,
            path: Some("/inbound/mailgun".into()),
            mailgun_signing_key: Some("key-acme".into()),
        };
        let tunnel = Tunnel::new(base.clone(), HashMap::new())
            .unwrap()
            .with_emails(client(&base), options.clone());
        assert!(tunnel.forward(&email("e2")).await.success);

        let postmark = Tunnel::new(base.clone(), HashMap::new())
            .unwrap()
            .with_emails(
                client(&base),
                EmailOptions {
                    format: EmailFormat::Postmark,
                    ..options
                },
            );
        assert!(postmark.forward(&email("e3")).await.success);

        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.renders[0].2,
            serde_json::json!({ "format": "mailgun", "mailgunSigningKey": "key-acme" })
        );
        assert_eq!(
            seen.renders[1].2,
            serde_json::json!({ "format": "postmark" })
        );
        assert_eq!(seen.deliveries[0].path, "/inbound/mailgun");
        assert_eq!(
            seen.deliveries[0].headers["content-type"],
            "application/x-www-form-urlencoded"
        );
    }

    #[tokio::test]
    async fn a_render_failure_is_reported_and_nothing_is_posted() {
        let (base, seen) = start_server().await;
        let tunnel = Tunnel::new(base.clone(), HashMap::new())
            .unwrap()
            .with_emails(client(&base), EmailOptions::default());

        let result = tunnel.forward(&email("gone")).await;
        assert!(!result.success);
        let error = result.error.unwrap();
        assert!(error.starts_with("could not render the email"), "{error}");
        assert!(error.contains("not_found"), "{error}");
        assert!(seen.lock().unwrap().deliveries.is_empty());
    }

    #[tokio::test]
    async fn without_email_options_emails_are_skipped() {
        let (base, seen) = start_server().await;
        let tunnel = Tunnel::new(base, HashMap::new()).unwrap();
        let result = tunnel.forward(&email("e4")).await;
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some(EMAIL_SKIPPED));
        let seen = seen.lock().unwrap();
        assert!(seen.renders.is_empty() && seen.deliveries.is_empty());
    }
}
