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
    // Trimmed only to tell an empty or `-` value; the path is kept as given.
    match output {
        Some(path) if path.trim().is_empty() => {
            Err(CliError::Usage("-o needs a file name".into()).into())
        }
        // `-o -` is stdout, as for most tools, under the same rules.
        Some("-") => sink(None, json, stdout_is_terminal),
        Some(path) if std::path::Path::new(path).is_dir() => Err(CliError::Usage(format!(
            "-o names a directory ({}): give the file to write, such as {}/message.eml",
            sanitize_line(path),
            sanitize_line(path.trim_end_matches('/'))
        ))
        .into()),
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

/// The name part of the temporary file: the target's name cut to about 100
/// bytes on a character boundary, so a long name that is valid on its own
/// does not grow past the file system's limit once the suffix is added.
fn temp_stem(name: &str) -> &str {
    const MAX: usize = 100;
    if name.len() <= MAX {
        return name;
    }
    let mut end = MAX;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    &name[..end]
}

/// Writes the download to `path`. A device, FIFO or socket there (also
/// behind a link, such as `/dev/stdout` or `/dev/null`) is opened and
/// written as it is. Otherwise the file is written whole or not at all: to
/// a temporary file beside it, then renamed over it, so a failed write never
/// leaves a cut-off file or loses the one that was there.
fn write_whole(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = std::path::Path::new(path);
    // Followed through links: what the bytes would land in.
    if let Ok(meta) = std::fs::metadata(target)
        && !meta.is_file()
        && !meta.is_dir()
    {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new().write(true).open(target)?;
        file.write_all(bytes)?;
        return file.flush();
    }
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let stem = temp_stem(&name);
    // A fresh name each try, created only if nothing is there (O_EXCL), so a
    // file or link planted at a guessable name is never written through.
    // Private until the mode is settled: an email can hold anything.
    let mut attempt = 0u32;
    let (temp, mut file) = loop {
        let suffix: u64 = rand::random();
        let temp = dir.join(format!(".{stem}.whk-{suffix:016x}.part"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => break (temp, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => {
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    };
    let written = (|| {
        use std::io::Write as _;
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            // The old file's permission bits when it is a regular file of
            // this user's (never setuid, setgid or sticky, and never read
            // through a link), else private ones.
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let uid = file.metadata()?.uid();
            let mode = std::fs::symlink_metadata(target)
                .ok()
                .filter(|meta| meta.is_file() && meta.uid() == uid)
                .map(|meta| meta.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
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
    if !crate::util::is_uuid(request_id) {
        return Err(CliError::Usage(format!(
            "{} is not a request id: `whk requests list <slug>` shows them",
            sanitize_line(request_id)
        ))
        .into());
    }
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
    write_whole(&path, &answer.body).with_context(|| format!("failed to write {path}"))?;
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

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_mode_and_a_link_there_is_not_followed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("whk-write-whole-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("m.eml");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_whole(target.to_str().unwrap(), b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // A new file is private.
        let fresh = dir.join("fresh.eml");
        write_whole(fresh.to_str().unwrap(), b"x").unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A link at the path is replaced; what it pointed at is untouched.
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        let link = dir.join("link.eml");
        std::os::unix::fs::symlink(&victim, &link).unwrap();
        write_whole(link.to_str().unwrap(), b"mail").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert!(
            !std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // No temporary file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_kept_mode_is_only_permission_bits_from_a_file_of_ones_own() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        // setuid, setgid and sticky are never carried over.
        let target = dir.join("m.eml");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o7755)).unwrap();
        write_whole(target.to_str().unwrap(), b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        // A link's target is not where the mode comes from: the new file is
        // private.
        let open = dir.join("open.txt");
        std::fs::write(&open, b"keep").unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o644)).unwrap();
        let link = dir.join("link.eml");
        std::os::unix::fs::symlink(&open, &link).unwrap();
        write_whole(link.to_str().unwrap(), b"mail").unwrap();
        assert_eq!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        assert_eq!(std::fs::read(&open).unwrap(), b"keep");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_device_or_fifo_is_written_in_place() {
        use std::os::unix::fs::FileTypeExt;
        let dir = scratch("device");
        // A character device, directly and behind a link, stays what it is.
        write_whole("/dev/null", b"gone").unwrap();
        assert!(
            std::fs::metadata("/dev/null")
                .unwrap()
                .file_type()
                .is_char_device()
        );
        let link = dir.join("null.eml");
        std::os::unix::fs::symlink("/dev/null", &link).unwrap();
        write_whole(link.to_str().unwrap(), b"gone").unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // A FIFO gets the bytes, and is not replaced by a file.
        let fifo = dir.join("pipe");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let reader = {
            let fifo = fifo.clone();
            std::thread::spawn(move || std::fs::read(fifo).unwrap())
        };
        write_whole(fifo.to_str().unwrap(), b"through the pipe").unwrap();
        assert_eq!(reader.join().unwrap(), b"through the pipe");
        assert!(
            std::fs::symlink_metadata(&fifo)
                .unwrap()
                .file_type()
                .is_fifo()
        );
        // Nothing else was made beside them.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_long_name_gets_a_temporary_name_that_fits() {
        // 85 two-byte characters: 170 bytes, under the usual 255 limit, which
        // the temporary name would pass without the cut.
        let name: String = std::iter::repeat_n('\u{e9}', 85).collect();
        assert_eq!(temp_stem(&name).len(), 100);
        assert!(name.starts_with(temp_stem(&name)));
        let odd = format!("a{name}");
        assert_eq!(temp_stem(&odd).len(), 99, "cut on a character boundary");
        assert_eq!(temp_stem("m.eml"), "m.eml");
        let dir = scratch("long");
        let target = dir.join(&name);
        write_whole(target.to_str().unwrap(), b"x").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"x");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_dash_is_stdout_and_a_directory_is_refused() {
        assert_eq!(sink(Some("-"), false, false).unwrap(), Sink::Stdout);
        assert!(sink(Some("-"), false, true).is_err(), "never to a terminal");
        assert!(
            sink(Some("-"), true, false).is_err(),
            "never mixed with --json"
        );
        let dir = std::env::temp_dir();
        let error = sink(dir.to_str(), false, false).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert!(error.to_string().contains("directory"), "{error}");
    }

    #[tokio::test]
    async fn a_value_that_is_not_an_id_is_refused_before_any_call() {
        let error = run(
            &client("http://127.0.0.1:9"),
            "acme",
            Download::Raw,
            Some("x.eml"),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[tokio::test]
    async fn writes_only_to_the_path_given() {
        let app = axum::Router::new().route(
            "/api/requests/{id}/attachments/{index}",
            axum::routing::get(
                |axum::extract::Path((id, index)): axum::extract::Path<(String, u32)>| async move {
                    assert_eq!(
                        (id.as_str(), index),
                        ("0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5", 2)
                    );
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
            "0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5",
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
            "0d9e8f7a-6b5c-4d3e-8f21-a0b1c2d3e4f5",
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
