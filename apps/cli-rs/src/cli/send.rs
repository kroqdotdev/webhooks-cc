use anyhow::{Result, bail};
use std::collections::HashMap;
use std::io::Read;

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
            let file = std::fs::File::open(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            let mut limited = file.take(10 * 1024 * 1024 + 1);
            let mut contents = String::new();
            limited
                .read_to_string(&mut contents)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            if contents.len() > 10 * 1024 * 1024 {
                bail!("file too large (max 10MB)");
            }
            Some(contents)
        }
        Some(d) => Some(d.to_string()),
        None => None,
    };

    let req = SendWebhookRequest {
        method: method.to_uppercase(),
        slug: slug.to_string(),
        path: None,
        headers: if header_map.is_empty() {
            None
        } else {
            Some(header_map)
        },
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
        println!(
            "  {} Sent {} to {} -> {}",
            green("✓"),
            bold(method),
            bold(slug),
            status_str
        );
        if let Some(ref body) = resp.body
            && !body.is_empty()
        {
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
            let file = std::fs::File::open(path)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            let mut limited = file.take(10 * 1024 * 1024 + 1);
            let mut contents = String::new();
            limited
                .read_to_string(&mut contents)
                .map_err(|e| anyhow::anyhow!("failed to read {path}: {e}"))?;
            if contents.len() > 10 * 1024 * 1024 {
                bail!("file too large (max 10MB)");
            }
            Some(contents)
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
        println!(
            "  {} Sent {} to {} -> {}",
            green("✓"),
            bold(method),
            dim(url),
            status_str
        );
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

/// The body for `whk send-email`.
pub fn test_email_body(slug: &str, tag: Option<&str>, template: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({ "slug": slug.trim() });
    if let Some(tag) = tag {
        body["tag"] = serde_json::json!(tag.trim());
    }
    if let Some(template) = template {
        body["template"] = serde_json::json!(template.trim());
    }
    body
}

/// Has the server deliver a sample email (a 6-digit code and a link, or a
/// ready-made layout's sample) to an endpoint. It counts as one request and
/// skips SMTP, so sender checks do not run on it.
pub async fn send_test_email(
    client: &ApiClient,
    slug: &str,
    tag: Option<&str>,
    template: Option<&str>,
    json_output: bool,
) -> Result<()> {
    let answer = client
        .send_test_email(&test_email_body(slug, tag, template))
        .await?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&answer.json())?);
        return Ok(());
    }
    let to = match tag {
        Some(tag) => format!("{}+{}", slug.trim(), tag.trim()),
        None => slug.trim().to_string(),
    };
    let id = answer
        .value
        .get("requestId")
        .and_then(serde_json::Value::as_str);
    println!(
        "  {} Sent a test email to {}",
        green("✓"),
        bold(&crate::cli::output::sanitize_line(&to))
    );
    if let Some(id) = id {
        println!(
            "  {} whk requests get {}",
            dim("See it:"),
            crate::cli::output::sanitize_line(id)
        );
    }
    Ok(())
}

#[cfg(test)]
mod test_email_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sends_only_what_was_given() {
        assert_eq!(
            test_email_body("acme", None, None),
            json!({ "slug": "acme" })
        );
        assert_eq!(
            test_email_body(" acme ", Some("run-1"), Some("shopify-order")),
            json!({ "slug": "acme", "tag": "run-1", "template": "shopify-order" })
        );
    }

    #[tokio::test]
    async fn posts_to_the_test_email_route() {
        let app = axum::Router::new().route(
            "/api/send-test-email",
            axum::routing::post(
                |axum::Json(body): axum::Json<serde_json::Value>| async move {
                    assert_eq!(body, json!({ "slug": "acme", "tag": "t1" }));
                    axum::Json(json!({ "status": "captured", "requestId": "r1" }))
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), Some("whcc_test".into()), None)
                .unwrap();
        send_test_email(&client, "acme", Some("t1"), None, true)
            .await
            .unwrap();
    }
}
