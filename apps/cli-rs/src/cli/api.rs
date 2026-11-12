//! `whk api <path>`: any API route with the CLI's credentials, like `gh api`.
//! It covers whatever has no command of its own yet, so an agent is never
//! sent to the dashboard for something the API can do.

use std::io::{Read, Write};

use anyhow::{Context, Result, bail};
use reqwest::Method;

use crate::api::ApiClient;
use crate::api::client::{api_error, retry_after};
use crate::error::CliError;

pub async fn run(
    client: &ApiClient,
    path: &str,
    method: Option<&str>,
    data: Option<&str>,
    headers: &[String],
    include: bool,
) -> Result<()> {
    let path = api_path(path)?;
    client.require_auth()?;
    let body = data.map(read_data).transpose()?;
    let method = match method {
        Some(m) => Method::from_bytes(m.trim().to_ascii_uppercase().as_bytes())
            .map_err(|_| CliError::Usage(format!("invalid HTTP method: {m}")))?,
        None if body.is_some() => Method::POST,
        None => Method::GET,
    };
    let headers = headers
        .iter()
        .map(|h| {
            h.split_once(':')
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .ok_or_else(|| {
                    CliError::Usage(format!("invalid header: {h} (expected Key:Value)")).into()
                })
        })
        .collect::<Result<Vec<_>>>()?;

    let resp = client.send_raw(method, &path, body, &headers).await?;

    if include {
        let mut err = std::io::stderr().lock();
        writeln!(err, "HTTP {}", resp.status)?;
        for (name, value) in &resp.headers {
            writeln!(err, "{name}: {}", value.to_str().unwrap_or("<binary>"))?;
        }
        writeln!(err)?;
    }

    let mut out = std::io::stdout().lock();
    out.write_all(&resp.body)?;
    if !resp.body.is_empty() && !resp.body.ends_with(b"\n") {
        out.write_all(b"\n")?;
    }
    out.flush()?;

    if resp.status.is_client_error() || resp.status.is_server_error() {
        let text = String::from_utf8_lossy(&resp.body);
        return Err(api_error(resp.status, &text, retry_after(&resp.headers)).into());
    }
    Ok(())
}

/// The path to request: under `/api`, never another host (the bearer must
/// only ever go to webhooks.cc).
fn api_path(path: &str) -> Result<String> {
    let path = path.trim();
    if path.contains("://") || path.starts_with("//") {
        return Err(CliError::Usage(
            "give an API path such as /api/endpoints, not a URL (whk only sends your credentials to the configured API)"
                .into(),
        )
        .into());
    }
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err(CliError::Usage("give an API path such as /api/endpoints".into()).into());
    }
    if trimmed == "api" || trimmed.starts_with("api/") || trimmed.starts_with("api?") {
        Ok(format!("/{trimmed}"))
    } else {
        Ok(format!("/api/{trimmed}"))
    }
}

/// `-d`: the text itself, `@file`, or `@-` for stdin.
fn read_data(data: &str) -> Result<Vec<u8>> {
    match data.strip_prefix('@') {
        Some("-") => {
            let mut buf = Vec::new();
            std::io::stdin()
                .read_to_end(&mut buf)
                .context("failed to read the body from stdin")?;
            Ok(buf)
        }
        Some(file) => {
            if file.is_empty() {
                bail!("-d @ needs a file name, or @- for stdin");
            }
            std::fs::read(file).with_context(|| format!("failed to read {file}"))
        }
        None => Ok(data.as_bytes().to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_land_under_api() {
        assert_eq!(api_path("endpoints").unwrap(), "/api/endpoints");
        assert_eq!(api_path("/api/endpoints").unwrap(), "/api/endpoints");
        assert_eq!(api_path("api/usage").unwrap(), "/api/usage");
        assert_eq!(
            api_path("endpoints/acme/requests?limit=5").unwrap(),
            "/api/endpoints/acme/requests?limit=5"
        );
        // "apis" is not the api prefix.
        assert_eq!(api_path("apis").unwrap(), "/api/apis");
    }

    #[test]
    fn other_hosts_are_refused() {
        assert!(api_path("https://evil.example/api/endpoints").is_err());
        assert!(api_path("//evil.example/x").is_err());
        assert!(api_path("  ").is_err());
    }

    #[test]
    fn data_is_text_or_a_file() {
        assert_eq!(read_data(r#"{"a":1}"#).unwrap(), br#"{"a":1}"#);
        let dir = std::env::temp_dir().join(format!("whk-api-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("body.json");
        std::fs::write(&file, b"{}").unwrap();
        assert_eq!(read_data(&format!("@{}", file.display())).unwrap(), b"{}");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(read_data("@").is_err());
    }
}
