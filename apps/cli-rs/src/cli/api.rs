//! `whk api <path>`: any API route with the CLI's credentials, like `gh api`.
//! It covers whatever has no command of its own yet, so an agent is never
//! sent to the dashboard for something the API can do.

use std::io::{IsTerminal, Read, Write};

use anyhow::{Context, Result};
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue, USER_AGENT};

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
    let headers = header_map(headers)?;

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
    // The body goes out byte for byte; only a terminal gets a line end, so
    // the prompt does not land after the JSON.
    if out.is_terminal() && !resp.body.is_empty() && !resp.body.ends_with(b"\n") {
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
    // A trailing slash (`endpoints/`) names the same route.
    let trimmed = path.trim_start_matches('/');
    let trimmed = match trimmed.split_once('?') {
        Some((route, query)) => format!("{}?{query}", route.trim_end_matches('/')),
        None => trimmed.trim_end_matches('/').to_string(),
    };
    let trimmed = trimmed.as_str();
    if trimmed.is_empty() {
        return Err(CliError::Usage("give an API path such as /api/endpoints".into()).into());
    }
    if trimmed == "api" || trimmed.starts_with("api/") || trimmed.starts_with("api?") {
        Ok(format!("/{trimmed}"))
    } else {
        Ok(format!("/api/{trimmed}"))
    }
}

/// `-H Key:Value` flags as headers. Malformed ones, and `Authorization` or
/// `User-Agent` (whk sends its own), are usage errors.
fn header_map(headers: &[String]) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    for h in headers {
        let usage = |why: String| -> anyhow::Error { CliError::Usage(why).into() };
        let (name, value) = h
            .split_once(':')
            .ok_or_else(|| usage(format!("invalid header: {h} (expected Key:Value)")))?;
        let name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| usage(format!("invalid header name: {}", name.trim())))?;
        if name == AUTHORIZATION || name == USER_AGENT {
            return Err(usage(format!("whk sets the {name} header itself")));
        }
        let value = HeaderValue::from_str(value.trim())
            .map_err(|_| usage(format!("invalid value for header {name}")))?;
        map.insert(name, value);
    }
    Ok(map)
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
                return Err(
                    CliError::Usage("-d @ needs a file name, or @- for stdin".into()).into(),
                );
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
        assert_eq!(api_path("endpoints/").unwrap(), "/api/endpoints");
        assert_eq!(
            api_path("endpoints/acme/?limit=5").unwrap(),
            "/api/endpoints/acme?limit=5"
        );
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
        let error = read_data("@").unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "usage");
    }

    #[test]
    fn bad_headers_are_usage_errors() {
        let ok = header_map(&["Content-Type: text/plain".into()]).unwrap();
        assert_eq!(ok["content-type"], "text/plain");
        for bad in [
            "no-colon",
            "Bad Header: x",
            "X-Ok: a\nb",
            "Authorization: Bearer x",
            "user-agent: me",
        ] {
            let error = header_map(&[bad.to_string()]).unwrap_err();
            let c = crate::error::classify(&error);
            assert_eq!((c.code, c.exit), ("usage", 2), "{bad}");
        }
    }
}
