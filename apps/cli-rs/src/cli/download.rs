//! `whk requests download`: a stored email's exact message, or one of its
//! decoded attachments, saved to the file `-o` names or piped out.
//!
//! The bytes are the sender's, so they never go to a terminal, where control
//! sequences in them would act on it; and the file name never comes from the
//! attachment, whose name the sender chose too (`../../.bashrc`). `-o` is the
//! only path whk writes to.

use std::io::{IsTerminal, Write};

use anyhow::{Context, Result};
use reqwest::header::{CONTENT_DISPOSITION, CONTENT_TYPE, HeaderMap};
use serde_json::json;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize_line};
use crate::error::CliError;
use crate::util::format::format_bytes;

/// What to download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Download {
    /// The exact message, as received (`.eml`).
    Raw,
    /// One decoded attachment, by its position from 0.
    Attachment(u32),
}

/// Where the bytes go.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Sink {
    File(String),
    Stdout,
}

/// The sink for `-o`, refusing what would put the bytes on a terminal or
/// mix them with `--json`'s output. Decided before anything is downloaded.
fn sink(output: Option<&str>, json: bool, stdout_is_terminal: bool) -> Result<Sink> {
    match output.map(str::trim) {
        Some("") => Err(CliError::Usage("-o needs a file name".into()).into()),
        Some(path) => Ok(Sink::File(path.to_string())),
        None if json => Err(CliError::Usage(
            "With --json, stdout carries the JSON: pass -o <file> to say where the download goes."
                .into(),
        )
        .into()),
        None if stdout_is_terminal => Err(CliError::Usage(
            "This would print a file to the terminal: pass -o <file> to save it, or pipe the output."
                .into(),
        )
        .into()),
        None => Ok(Sink::Stdout),
    }
}

/// The name the server gives the file (`filename*`, else `filename`), for
/// display only: it is never used as a path.
fn served_name(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(CONTENT_DISPOSITION)?.to_str().ok()?;
    let mut plain = None;
    for part in value.split(';').map(str::trim) {
        if let Some(encoded) = part.strip_prefix("filename*=") {
            let encoded = encoded
                .strip_prefix("UTF-8''")
                .or_else(|| encoded.strip_prefix("utf-8''"))
                .unwrap_or(encoded);
            let bytes: Vec<u8> = percent_encoding::percent_decode_str(encoded).collect();
            let name = String::from_utf8_lossy(&bytes).to_string();
            if !name.is_empty() {
                return Some(name);
            }
        } else if let Some(name) = part.strip_prefix("filename=") {
            plain = Some(name.trim_matches('"').to_string());
        }
    }
    plain.filter(|name| !name.is_empty())
}

fn content_type(headers: &HeaderMap) -> Option<String> {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// The routes answer some failures with a bare code; say what it means,
/// keeping the status (and so the exit) the API gave.
fn explain(error: anyhow::Error, request_id: &str, what: Download) -> anyhow::Error {
    let mut api = match error.downcast::<crate::error::ApiError>() {
        Ok(api) => api,
        Err(error) => return error,
    };
    let id = sanitize_line(request_id);
    match api.message.as_str() {
        "not_found" => {
            api.message = match what {
                Download::Raw => format!("No captured request {id} you can read."),
                Download::Attachment(index) => format!(
                    "Request {id} has no attachment {index} (they count from 0), or is not an email you can read."
                ),
            }
        }
        "not_an_email" => {
            api.message = format!(
                "Request {id} is an HTTP request, not an email: `whk requests get {id} --json` has its body."
            )
        }
        _ => {}
    }
    api.into()
}

pub async fn run(
    client: &ApiClient,
    request_id: &str,
    what: Download,
    output: Option<&str>,
    json: bool,
) -> Result<()> {
    let sink = sink(output, json, std::io::stdout().is_terminal())?;
    let request_id = request_id.trim();
    let answer = match what {
        Download::Raw => client.download_raw(request_id).await,
        Download::Attachment(index) => client.download_attachment(request_id, index).await,
    }
    .map_err(|error| explain(error, request_id, what))?;
    let name = served_name(&answer.headers);
    let kind = content_type(&answer.headers);
    let path = match sink {
        Sink::Stdout => {
            let mut stdout = std::io::stdout().lock();
            stdout
                .write_all(&answer.body)
                .and_then(|()| stdout.flush())
                .context("failed to write the download to stdout")?;
            return Ok(());
        }
        Sink::File(path) => path,
    };
    std::fs::write(&path, &answer.body).with_context(|| format!("failed to write {path}"))?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "path": path,
                "bytes": answer.body.len(),
                "contentType": kind,
                "filename": name,
            }))?
        );
        return Ok(());
    }
    let label = match what {
        Download::Raw => "the message".to_string(),
        Download::Attachment(index) => format!("attachment {index}"),
    };
    println!(
        "{} Saved {label} ({}) to {}",
        green("✓"),
        format_bytes(answer.body.len()),
        bold(&sanitize_line(&path))
    );
    let mut about = Vec::new();
    match (name, what) {
        (Some(name), Download::Attachment(_)) => {
            about.push(format!("named \"{}\" by its sender", sanitize_line(&name)))
        }
        (Some(name), Download::Raw) => {
            about.push(format!("served as \"{}\"", sanitize_line(&name)))
        }
        (None, _) => {}
    }
    if let Some(kind) = kind {
        about.push(sanitize_line(&kind));
    }
    if !about.is_empty() {
        println!("  {}", dim(&about.join(", ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;
    use reqwest::header::HeaderValue;

    #[test]
    fn never_prints_a_file_to_a_terminal() {
        let error = sink(None, false, true).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert!(error.to_string().contains("-o"), "{error}");
        assert_eq!(sink(None, false, false).unwrap(), Sink::Stdout);
    }

    #[test]
    fn json_needs_a_file() {
        let error = sink(None, true, false).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert_eq!(
            sink(Some("out.eml"), true, true).unwrap(),
            Sink::File("out.eml".into())
        );
        assert_eq!(
            classify(&sink(Some(" "), false, false).unwrap_err()).code,
            "usage"
        );
    }

    #[test]
    fn reads_the_served_name_for_display() {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_DISPOSITION,
            HeaderValue::from_static(
                "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
            ),
        );
        assert_eq!(
            served_name(&headers).as_deref(),
            Some("r\u{e9}sum\u{e9}.pdf")
        );
        headers.insert(
            CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"email-1234.eml\""),
        );
        assert_eq!(served_name(&headers).as_deref(), Some("email-1234.eml"));
        assert_eq!(served_name(&HeaderMap::new()), None);
    }

    /// An empty directory of this test's own.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "whk-download-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    fn client(base: &str) -> ApiClient {
        ApiClient::with_credentials(Some(base), Some(base), Some("whcc_test".into()), None).unwrap()
    }

    #[tokio::test]
    async fn writes_only_to_the_path_given() {
        let app = axum::Router::new().route(
            "/api/requests/{id}/attachments/{index}",
            axum::routing::get(
                |axum::extract::Path((id, index)): axum::extract::Path<(String, u32)>| async move {
                    assert_eq!((id.as_str(), index), ("r1", 2));
                    (
                        [
                            ("content-type", "application/pdf"),
                            (
                                "content-disposition",
                                "attachment; filename=\"../evil.pdf\"",
                            ),
                        ],
                        vec![0u8, 159, 146, 150],
                    )
                },
            ),
        );
        let base = serve(app).await;
        let dir = scratch("attachment");
        let path = dir.join("out.bin");
        run(
            &client(&base),
            "r1",
            Download::Attachment(2),
            Some(path.to_str().unwrap()),
            true,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![0u8, 159, 146, 150]);
        assert!(!dir.parent().unwrap().join("evil.pdf").exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bare_codes_are_put_in_words() {
        let api = |message: &str, status| {
            anyhow::Error::new(crate::error::ApiError {
                status,
                message: message.into(),
                retry_after: None,
            })
        };
        let error = explain(api("not_found", 404), "r1", Download::Attachment(3));
        assert!(error.to_string().contains("no attachment 3"), "{error}");
        assert_eq!(classify(&error).code, "not_found");
        let error = explain(api("not_an_email", 400), "r1", Download::Raw);
        assert!(error.to_string().contains("HTTP request"), "{error}");
        assert_eq!(classify(&error).code, "bad_request");
        let kept = explain(
            api("The stored message is no longer available.", 404),
            "r1",
            Download::Raw,
        );
        assert_eq!(
            kept.to_string(),
            "The stored message is no longer available."
        );
    }

    #[tokio::test]
    async fn a_message_that_was_not_kept_is_not_found() {
        let app = axum::Router::new().route(
            "/api/requests/{id}/raw",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(json!({
                        "error": "not_kept",
                        "message": "The full message was larger than 1 MiB and was not kept."
                    })),
                )
            }),
        );
        let base = serve(app).await;
        let dir = scratch("raw");
        let path = dir.join("m.eml");
        let error = run(
            &client(&base),
            "r1",
            Download::Raw,
            Some(path.to_str().unwrap()),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "not_found");
        assert!(error.to_string().contains("larger than 1 MiB"), "{error}");
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
