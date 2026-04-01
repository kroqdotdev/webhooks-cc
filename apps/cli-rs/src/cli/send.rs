use anyhow::Result;
use std::collections::HashMap;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, red};
use crate::types::SendWebhookRequest;

pub async fn send_to_endpoint(
    client: &ApiClient,
    slug: &str,
    method: &str,
    headers: Vec<String>,
    data: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let header_map = parse_headers(&headers)?;

    // If data starts with @, read from file
    let body = match data {
        Some(d) if d.starts_with('@') => {
            let path = &d[1..];
            let meta = std::fs::metadata(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            if meta.len() > 10 * 1024 * 1024 {
                anyhow::bail!("file too large ({} bytes, max 10MB)", meta.len());
            }
            Some(std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?)
        }
        Some(d) => Some(d.to_string()),
        None => None,
    };

    let req = SendWebhookRequest {
        method: method.to_uppercase(),
        slug: slug.to_string(),
        path: None,
        headers: if header_map.is_empty() { None } else { Some(header_map) },
        body,
    };

    let resp = client.send_webhook(&req).await?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&resp)?);
    } else {
        let status_str = if resp.status < 400 {
            green(&format!("{} {}", resp.status, resp.status_text))
        } else {
            red(&format!("{} {}", resp.status, resp.status_text))
        };
        println!("  {} Sent {} to {} -> {}", green("✓"), bold(method), bold(slug), status_str);
        if let Some(ref body) = resp.body && !body.is_empty() {
            println!("\n{}", dim(&body.chars().take(500).collect::<String>()));
        }
    }

    Ok(())
}

pub async fn send_to_url(
    client: &ApiClient,
    url: &str,
    method: &str,
    headers: Vec<String>,
    data: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let header_map = parse_headers(&headers)?;

    let body = match data {
        Some(d) if d.starts_with('@') => {
            let path = &d[1..];
            let meta = std::fs::metadata(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            if meta.len() > 10 * 1024 * 1024 {
                anyhow::bail!("file too large ({} bytes, max 10MB)", meta.len());
            }
            Some(std::fs::read_to_string(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?)
        }
        Some(d) => Some(d.to_string()),
        None => None,
    };

    let resp = client
        .send_to(url, method, &header_map, body.as_deref())
        .await?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&resp)?);
    } else {
        let status_str = if resp.status < 400 {
            green(&format!("{} {}", resp.status, resp.status_text))
        } else {
            red(&format!("{} {}", resp.status, resp.status_text))
        };
        println!("  {} Sent {} to {} -> {}", green("✓"), bold(method), dim(url), status_str);
    }

    Ok(())
}

fn parse_headers(headers: &[String]) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for h in headers {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("invalid header: {h} (expected Key:Value)"))?;
        map.insert(k.trim().to_string(), v.trim().to_string());
    }
    Ok(map)
}
