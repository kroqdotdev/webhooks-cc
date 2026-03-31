use anyhow::Result;
use std::io::{self, Write};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, print_request_detail, print_request_line};
use crate::cli::ExportFormat;

pub async fn list(
    client: &ApiClient,
    slug: &str,
    limit: u32,
    since: Option<i64>,
    cursor: Option<String>,
    json: bool,
) -> Result<()> {
    if let Some(ref c) = cursor {
        let result = client.list_requests_paginated(slug, Some(limit), Some(c)).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result)?);
            return Ok(());
        }
        if result.requests.is_empty() {
            println!("  No requests found.");
            return Ok(());
        }
        for req in &result.requests {
            print_request_line(req);
        }
        if let Some(ref next) = result.next_cursor {
            println!("\n  {} --cursor {}", dim("Next page:"), next);
        }
    } else {
        let result = client.list_requests(slug, Some(limit), since).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result)?);
            return Ok(());
        }
        if result.requests.is_empty() {
            println!("  No requests found.");
            return Ok(());
        }
        for req in &result.requests {
            print_request_line(req);
        }
        if let Some(count) = result.count {
            println!("\n  {} {count} total", dim("Showing up to {limit} of"));
        }
    }
    Ok(())
}

pub async fn get(client: &ApiClient, id: &str, json: bool) -> Result<()> {
    let req = client.get_request(id).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&req)?);
    } else {
        print_request_detail(&req);
    }
    Ok(())
}

pub async fn search(
    client: &ApiClient,
    slug: Option<&str>,
    method: Option<&str>,
    q: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    limit: u32,
    offset: u32,
    order: &str,
    json: bool,
) -> Result<()> {
    let result = client
        .search_requests(slug, method, q, from, to, Some(limit), Some(offset), Some(order))
        .await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

    if result.requests.is_empty() {
        println!("  No matching requests found.");
        return Ok(());
    }

    for req in &result.requests {
        print_request_line(req);
    }
    println!("\n  {} {}", dim("Total matches:"), result.total);

    Ok(())
}

pub async fn count(
    client: &ApiClient,
    slug: Option<&str>,
    method: Option<&str>,
    q: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    json: bool,
) -> Result<()> {
    let result = client.count_requests(slug, method, q, from, to).await?;

    if json {
        println!("{}", serde_json::json!({ "count": result.count }));
    } else {
        println!("  {} {}", bold("Count:"), result.count);
    }
    Ok(())
}

pub async fn clear(
    client: &ApiClient,
    slug: &str,
    before: Option<&str>,
    force: bool,
    json: bool,
) -> Result<()> {
    if !force {
        let msg = match before {
            Some(b) => format!("Clear requests for {} before {}? [y/N] ", bold(slug), b),
            None => format!("Clear ALL requests for {}? [y/N] ", bold(slug)),
        };
        print!("  {msg}");
        io::stdout().flush()?;

        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("  Cancelled.");
            return Ok(());
        }
    }

    client.clear_requests(slug, before).await?;

    if json {
        println!("{}", serde_json::json!({ "cleared": true, "slug": slug }));
    } else {
        println!("  {} Cleared requests for {}", green("✓"), bold(slug));
    }
    Ok(())
}

pub async fn export(
    client: &ApiClient,
    slug: &str,
    format: &ExportFormat,
    limit: u32,
    since: Option<i64>,
    output: Option<&str>,
    _json: bool,
) -> Result<()> {
    let result = client.list_requests(slug, Some(limit), since).await?;

    if result.requests.is_empty() {
        println!("  No requests to export.");
        return Ok(());
    }

    let webhook_url = client.webhook_url_for(slug);
    let content = match format {
        ExportFormat::Har => build_har_export(&webhook_url, &result.requests),
        ExportFormat::Curl => build_curl_export(&webhook_url, &result.requests),
    };

    match output {
        Some(path) => {
            std::fs::write(path, &content)?;
            println!(
                "  {} Exported {} requests to {}",
                green("✓"),
                result.requests.len(),
                bold(path)
            );
        }
        None => print!("{content}"),
    }

    Ok(())
}

fn build_har_export(base_url: &str, requests: &[crate::types::CapturedRequest]) -> String {
    let entries: Vec<serde_json::Value> = requests
        .iter()
        .map(|r| {
            let headers: Vec<serde_json::Value> = r
                .headers
                .iter()
                .map(|(k, v)| serde_json::json!({ "name": k, "value": v }))
                .collect();

            let query: Vec<serde_json::Value> = r
                .query_params
                .iter()
                .map(|(k, v)| serde_json::json!({ "name": k, "value": v }))
                .collect();

            let url = format!("{}{}", base_url, r.path);

            let mut request = serde_json::json!({
                "method": r.method,
                "url": url,
                "httpVersion": "HTTP/1.1",
                "headers": headers,
                "queryString": query,
                "headersSize": -1,
                "bodySize": r.body.as_ref().map_or(0, |b| b.len()),
            });

            if let Some(ref body) = r.body {
                request["postData"] = serde_json::json!({
                    "mimeType": r.content_type.as_deref().unwrap_or("application/octet-stream"),
                    "text": body,
                });
            }

            serde_json::json!({
                "startedDateTime": crate::util::format::format_iso(r.received_at),
                "request": request,
                "response": { "status": 0, "statusText": "", "httpVersion": "HTTP/1.1", "headers": [], "content": { "size": 0, "mimeType": "" }, "headersSize": -1, "bodySize": -1 },
                "cache": {},
                "timings": { "send": 0, "wait": 0, "receive": 0 },
            })
        })
        .collect();

    let har = serde_json::json!({
        "log": {
            "version": "1.2",
            "creator": { "name": "webhooks.cc", "version": env!("WHK_VERSION") },
            "entries": entries,
        }
    });

    serde_json::to_string_pretty(&har).unwrap()
}

fn build_curl_export(base_url: &str, requests: &[crate::types::CapturedRequest]) -> String {
    let sensitive = ["authorization", "cookie", "proxy-authorization", "set-cookie"];

    requests
        .iter()
        .map(|r| {
            let url = format!("{}{}", base_url, r.path);
            let mut parts = vec![format!("curl -X {}", r.method)];

            for (k, v) in &r.headers {
                if sensitive.contains(&k.to_lowercase().as_str()) {
                    continue;
                }
                let escaped = v.replace('\'', "'\\''");
                parts.push(format!("-H '{}: {}'", k, escaped));
            }

            if let Some(ref body) = r.body {
                let escaped = body.replace('\'', "'\\''");
                parts.push(format!("-d '{}'", escaped));
            }

            parts.push(format!("'{url}'"));
            parts.join(" \\\n  ")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
