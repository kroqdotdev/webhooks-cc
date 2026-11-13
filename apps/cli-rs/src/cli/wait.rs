//! `whk wait <slug>`: block until a matching request or email arrives, print
//! it and exit. Built for agents: run it in the background, trigger the
//! sender, and the command's exit is the signal that something arrived.
//!
//! It reads the endpoint's live stream (`/api/stream/{slug}`, as `whk listen`
//! does) from a start time: the server first sends every request after it in
//! (received_at, id) order and then each new one as it lands, so a wait
//! never skips or repeats a request however many arrive, and it wakes at
//! once. The start is taken on the server's clock (see [`server_start`]):
//! five minutes back by default (as the SDKs' `waitFor` does), or the moment
//! the command started with `--since now`, so a request sent while the
//! stream connects still counts. A match is then read in full from
//! `/api/requests/{id}`, since the stream leaves out the parsed email and the
//! signature check.

use std::collections::HashSet;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::api::ApiClient;
use crate::cli::output::{dim, print_request_detail, print_request_line};
use crate::error::{ApiError, CliError, classify};
use crate::types::{CapturedRequest, SseEvent};
use crate::util::format::parse_duration;

/// How far back a wait looks when `--since` is not given (as the SDKs do).
const LOOKBACK_MS: i64 = 5 * 60 * 1000;
/// Slack for the start when the server sent no `Date` header and this
/// machine's clock is all there is.
const CLOCK_MARGIN_MS: i64 = 2000;
/// How long past `--timeout` the full read of a match that did arrive may
/// take before the stream's copy is printed instead.
const FULL_READ_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Kind {
    Http,
    Email,
}

pub struct WaitOptions {
    pub slug: String,
    pub timeout: String,
    pub count: u32,
    pub since: Option<String>,
    pub method: Option<String>,
    pub kind: Option<Kind>,
    pub path: Option<String>,
}

/// Where the wait starts.
#[derive(Debug, PartialEq)]
enum Since {
    /// Only what arrives after the command started, on the server's clock.
    Now,
    /// This long (ms) before the command started, on the server's clock.
    Back(i64),
    /// Requests received at or after this server time (ms).
    At(i64),
}

/// `--since`: unset is the default lookback, `now`, a duration back, or a
/// bare number as a timestamp (as for the other `--since` flags).
fn parse_since(since: Option<&str>) -> Result<Since> {
    let Some(since) = since.map(str::trim) else {
        return Ok(Since::Back(LOOKBACK_MS));
    };
    if since.eq_ignore_ascii_case("now") {
        return Ok(Since::Now);
    }
    if let Ok(at) = since.parse::<i64>() {
        return Ok(Since::At(at));
    }
    let back = parse_duration(since).map_err(|e| {
        CliError::Usage(format!(
            "--since takes \"now\", a duration such as 2m, or a timestamp in ms ({e})"
        ))
    })?;
    Ok(Since::Back(back))
}

struct Filter {
    method: Option<String>,
    kind: Option<Kind>,
    path: Option<String>,
}

impl Filter {
    fn matches(&self, request: &Value) -> bool {
        let text = |key: &str| request.get(key).and_then(Value::as_str).unwrap_or("");
        if let Some(method) = &self.method
            && !text("method").eq_ignore_ascii_case(method)
        {
            return false;
        }
        if let Some(kind) = self.kind {
            let is_email = match request.get("kind").and_then(Value::as_str) {
                Some(kind) => kind == "email",
                None => {
                    text("method").eq_ignore_ascii_case("EMAIL") && !text("path").starts_with('/')
                }
            };
            if is_email != (kind == Kind::Email) {
                return false;
            }
        }
        if let Some(path) = &self.path
            && !text("path").to_lowercase().contains(&path.to_lowercase())
        {
            return false;
        }
        true
    }
}

fn request_id(request: &Value) -> Option<String> {
    request
        .get("id")
        .or_else(|| request.get("_id"))
        .and_then(Value::as_str)
        .map(String::from)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The server's clock when the command started: the endpoint is read once
/// (which also fails early for a slug that does not exist), and its answer's
/// `Date` less the time it took is the start. `Date` counts whole seconds,
/// so this is at or before the true start: nothing sent after the command
/// started is missed, and at most a second before it can count.
async fn server_start(client: &ApiClient, slug: &str, deadline: Instant) -> Result<i64> {
    let path = format!("/api/endpoints/{}", urlencoding::encode(slug));
    let (resp, started, local) = retrying(deadline, || async {
        // Timed per try, so a retried read measures its own round trip.
        let started = std::time::Instant::now();
        let local = now_ms();
        Ok((client.get(&path).await?, started, local))
    })
    .await?;
    Ok(match resp.server_time_ms {
        Some(t) => t - started.elapsed().as_millis() as i64,
        None => local - CLOCK_MARGIN_MS,
    })
}

/// Whether a failed read is worth another try: rate limits, our side, the
/// network. A missing endpoint or refused credentials are final.
fn transient(error: &anyhow::Error) -> bool {
    matches!(
        classify(error).code,
        "rate_limited" | "server_error" | "network_error" | "request_timeout"
    )
}

/// Runs `call` until it succeeds, a failure is final, or `deadline` passes
/// (then `timeout`), waiting a second between tries or as long as the server
/// asked (`Retry-After`).
async fn retrying<T, F, Fut>(deadline: Instant, mut call: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    loop {
        let error = match tokio::time::timeout_at(deadline, call()).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(error)) if transient(&error) => error,
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(CliError::Timeout("the wait ran out of time".into()).into());
            }
        };
        let pause = Duration::from_secs(classify(&error).retry_after.unwrap_or(1).max(1));
        if Instant::now() + pause >= deadline {
            return Err(error);
        }
        tokio::time::sleep(pause).await;
    }
}

/// `--timeout`: a duration with a unit. A bare number would be milliseconds
/// (as everywhere `parse_duration` reads one), which ends a wait at once, so
/// it is refused here.
fn parse_timeout(timeout: &str) -> Result<i64> {
    if timeout.trim().parse::<i64>().is_ok() {
        return Err(CliError::Usage(format!(
            "--timeout needs a unit, such as {}s or {}m",
            timeout.trim(),
            timeout.trim()
        ))
        .into());
    }
    parse_duration(timeout).map_err(|e| CliError::Usage(format!("--timeout: {e}")).into())
}

pub async fn run(client: &ApiClient, options: WaitOptions, json: bool) -> Result<()> {
    client.require_auth()?;
    let timeout_ms = parse_timeout(&options.timeout)?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
    let filter = Filter {
        method: options.method.clone(),
        kind: options.kind,
        path: options.path.clone(),
    };
    let count = options.count.max(1) as usize;
    let slug = options.slug.as_str();
    // The arguments are checked before any request goes out; a duration
    // back is then counted from the server's start, as `now` is.
    let since = parse_since(options.since.as_deref())?;
    let start = server_start(client, slug, deadline).await?;
    let since = match since {
        Since::Now => start,
        Since::Back(back) => start - back,
        Since::At(at) => at,
    };

    if !json {
        let what = if count == 1 {
            "a request".to_string()
        } else {
            format!("{count} requests")
        };
        eprintln!(
            "  {}",
            dim(&format!(
                "Waiting up to {} for {what} at {slug}...",
                options.timeout
            ))
        );
    }

    let (tx, mut rx) = mpsc::channel(256);
    let stream_client = client.clone();
    let stream_slug = slug.to_string();
    let mut stream = tokio::spawn(async move {
        stream_client
            .stream_requests_from(&stream_slug, Some(since), tx)
            .await
    });

    let mut seen: HashSet<String> = HashSet::new();
    // Each match's id and the stream's copy of it.
    let mut matched: Vec<(String, Value)> = Vec::new();
    let outcome: Result<()> = loop {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(event) => event,
            Err(_) => {
                break Err(CliError::Timeout(format!(
                    "{} of {count} matching request(s) arrived at {slug} within {}",
                    matched.len(),
                    options.timeout
                ))
                .into());
            }
        };
        match event {
            Some(SseEvent::Request(req)) => {
                let value = req.json();
                let Some(id) = request_id(&value) else {
                    continue;
                };
                if seen.insert(id.clone()) && filter.matches(&value) {
                    matched.push((id, value));
                    if matched.len() >= count {
                        break Ok(());
                    }
                }
            }
            Some(SseEvent::EndpointDeleted) => {
                break Err(ApiError {
                    status: 404,
                    message: format!("Endpoint {slug} was deleted while waiting."),
                    retry_after: None,
                }
                .into());
            }
            Some(SseEvent::Reconnecting {
                attempt, reason, ..
            }) => {
                if !json {
                    eprintln!(
                        "  {}",
                        dim(&format!("Reconnecting (attempt {attempt}): {reason}"))
                    );
                }
            }
            Some(SseEvent::Connected | SseEvent::Timeout) => {}
            // The stream ended: its error (a missing endpoint, refused
            // credentials) says why.
            None => {
                break match (&mut stream).await {
                    Ok(Err(error)) => Err(error),
                    _ => Err(anyhow::anyhow!("the request stream ended unexpectedly")),
                };
            }
        }
    };
    drop(rx);
    if !stream.is_finished() {
        stream.abort();
    }
    outcome?;

    // Each match in full: the stream leaves out the parsed email, the
    // signature check and the answer the sender got. A match that arrived
    // is never lost to a failed read: within a few seconds past the wait's
    // own limit, else the stream's copy is printed.
    let read_by = deadline.max(Instant::now()) + FULL_READ_GRACE;
    let mut values = Vec::with_capacity(matched.len());
    for (id, streamed) in matched {
        match retrying(read_by, || client.get_request(&id)).await {
            Ok(full) => values.push(full.json()),
            Err(error) => {
                if !json {
                    eprintln!(
                        "  {}",
                        dim(&format!("Showing the streamed copy of {id}: {error:#}"))
                    );
                }
                values.push(streamed);
            }
        }
    }
    if json {
        let out = if count == 1 {
            values.into_iter().next().unwrap_or(Value::Null)
        } else {
            Value::Array(values)
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    let parsed: Vec<CapturedRequest> = values
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    if let [one] = parsed.as_slice() {
        print_request_detail(one);
    } else {
        for request in &parsed {
            print_request_line(request);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn since_reads_now_durations_and_timestamps() {
        assert_eq!(parse_since(None).unwrap(), Since::Back(LOOKBACK_MS));
        assert_eq!(parse_since(Some("now")).unwrap(), Since::Now);
        assert_eq!(parse_since(Some("2m")).unwrap(), Since::Back(120_000));
        assert_eq!(
            parse_since(Some("1774866106592")).unwrap(),
            Since::At(1774866106592)
        );
        let error = parse_since(Some("soon")).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[tokio::test]
    async fn transient_failures_are_retried_until_the_deadline() {
        let tries = std::cell::Cell::new(0);
        let deadline = Instant::now() + Duration::from_secs(5);
        let value = retrying(deadline, || {
            tries.set(tries.get() + 1);
            let n = tries.get();
            async move {
                if n < 2 {
                    Err(anyhow::Error::new(ApiError {
                        status: 503,
                        message: "busy".into(),
                        retry_after: None,
                    }))
                } else {
                    Ok(n)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(value, 2);

        // A final failure is not retried.
        tries.set(0);
        let error = retrying(deadline, || {
            tries.set(tries.get() + 1);
            async {
                Err::<(), _>(anyhow::Error::new(ApiError {
                    status: 404,
                    message: "gone".into(),
                    retry_after: None,
                }))
            }
        })
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "not_found");
        assert_eq!(tries.get(), 1);

        // Past the deadline the wait times out.
        let error = retrying(Instant::now(), || async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok::<_, anyhow::Error>(())
        })
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "timeout");
    }

    #[test]
    fn a_timeout_needs_a_unit() {
        assert_eq!(parse_timeout("30s").unwrap(), 30_000);
        assert_eq!(parse_timeout("2m").unwrap(), 120_000);
        let error = parse_timeout("30").unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert!(error.to_string().contains("30s"));
    }

    #[test]
    fn filters_match_method_kind_and_path() {
        let post = json!({"id":"1","method":"POST","path":"/stripe/events","receivedAt":1});
        let email = json!({"id":"2","method":"EMAIL","path":"orders@mailhooks.cc","kind":"email","receivedAt":2});
        let any = Filter {
            method: None,
            kind: None,
            path: None,
        };
        assert!(any.matches(&post) && any.matches(&email));

        let posts = Filter {
            method: Some("post".into()),
            kind: None,
            path: None,
        };
        assert!(posts.matches(&post) && !posts.matches(&email));

        let emails = Filter {
            method: None,
            kind: Some(Kind::Email),
            path: None,
        };
        assert!(!emails.matches(&post) && emails.matches(&email));
        let http = Filter {
            method: None,
            kind: Some(Kind::Http),
            path: None,
        };
        assert!(http.matches(&post) && !http.matches(&email));

        let stripe = Filter {
            method: None,
            kind: None,
            path: Some("STRIPE".into()),
        };
        assert!(stripe.matches(&post) && !stripe.matches(&email));

        // An older answer without `kind` is read the way the server reads it.
        let legacy = json!({"id":"3","method":"EMAIL","path":"a@mailhooks.cc"});
        assert!(emails.matches(&legacy));
    }
}
