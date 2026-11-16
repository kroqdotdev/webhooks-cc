use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, red, sanitize, sanitize_line};
use crate::util::body::resolve_body;

/// Headers to strip when replaying (hop-by-hop + sensitive + proxy).
const STRIP_HEADERS: &[&str] = &[
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "cdn-loop",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "true-client-ip",
    "via",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
];

pub async fn run(client: &ApiClient, request_id: &str, target_url: &str, json: bool) -> Result<()> {
    let request_id = crate::util::request_id(request_id)?;
    let req = client.get_request(request_id).await?;

    if req.is_email() {
        return Err(crate::error::CliError::Usage(format!(
            "{request_id} is a captured email, which cannot be replayed as an HTTP request. \
             To send emails to your server, use forwarding: https://webhooks.cc/docs/forwarding"
        ))
        .into());
    }

    let method: reqwest::Method = req.method.parse().unwrap_or(reqwest::Method::POST);
    let url = crate::tunnel::join_path(target_url, &req.path);

    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        if STRIP_HEADERS.contains(&k.to_lowercase().as_str()) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(name, val);
        }
    }

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let mut builder = http.request(method.clone(), &url).headers(headers);
    if let Some(bytes) = resolve_body(req.body_raw.as_deref(), req.body.as_deref()) {
        builder = builder.body(bytes);
    }

    let start = std::time::Instant::now();
    let resp = builder.send().await.context("replay request failed")?;
    let duration = start.elapsed();

    let status = resp.status();
    let response_headers: serde_json::Map<String, serde_json::Value> = resp
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                serde_json::Value::from(String::from_utf8_lossy(value.as_bytes()).into_owned()),
            )
        })
        .collect();
    let body = resp.text().await.unwrap_or_default();

    if json {
        crate::outln!(
            "{}",
            serde_json::json!({
                "url": url,
                "status": status.as_u16(),
                "statusText": status.to_string(),
                "duration_ms": duration.as_millis(),
                "headers": response_headers,
                "body": body,
                "bodySize": body.len(),
            })
        );
    } else {
        let status_str = if status.is_success() {
            green(&status.to_string())
        } else {
            red(&status.to_string())
        };
        crate::outln!(
            "  {} Replayed {} {} -> {} ({:.0?})",
            green("✓"),
            bold(&sanitize_line(&req.method)),
            sanitize_line(&url),
            status_str,
            duration,
        );
        if !body.is_empty() {
            crate::outln!(
                "\n{}",
                dim(&sanitize(&body.chars().take(500).collect::<String>()))
            );
        }
    }

    Ok(())
}
