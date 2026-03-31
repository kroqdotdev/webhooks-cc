use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, red};

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
    let req = client.get_request(request_id).await?;

    let method: reqwest::Method = req.method.parse().unwrap_or(reqwest::Method::POST);
    let url = format!("{}{}", target_url.trim_end_matches('/'), req.path);

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
    if let Some(ref body) = req.body {
        builder = builder.body(body.clone());
    }

    let start = std::time::Instant::now();
    let resp = builder.send().await.context("replay request failed")?;
    let duration = start.elapsed();

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if json {
        println!(
            "{}",
            serde_json::json!({
                "status": status.as_u16(),
                "statusText": status.to_string(),
                "duration_ms": duration.as_millis(),
                "bodySize": body.len(),
            })
        );
    } else {
        let status_str = if status.is_success() {
            green(&status.to_string())
        } else {
            red(&status.to_string())
        };
        println!(
            "  {} Replayed {} {} -> {} ({:.0?})",
            green("✓"),
            bold(&req.method),
            req.path,
            status_str,
            duration,
        );
        if !body.is_empty() {
            println!("\n{}", dim(&body.chars().take(500).collect::<String>()));
        }
    }

    Ok(())
}
