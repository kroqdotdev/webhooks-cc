//! `whk wait <slug>`: block until a matching request or email arrives, print
//! it and exit. Built for agents: run it in the background, trigger the
//! sender, and the command's exit is the signal that something arrived.
//!
//! It polls like the SDKs' `waitFor`: requests from the last five minutes
//! count unless `--since` says otherwise, each poll starts a little before the
//! newest request seen (on the server's clock), and repeats are skipped by id.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;

use crate::api::ApiClient;
use crate::cli::output::{dim, print_request_detail, print_request_line};
use crate::error::{CliError, classify};
use crate::types::CapturedRequest;
use crate::util::format::parse_duration;

/// How far back a wait looks when `--since` is not given (as the SDKs do).
const LOOKBACK_MS: i64 = 5 * 60 * 1000;
/// How far before the newest request seen the next poll starts: a capture
/// can commit after a newer one.
const OVERLAP_MS: i64 = 30 * 1000;
const POLL: Duration = Duration::from_secs(1);
const PAGE: u32 = 100;
/// Pages one poll follows back at most (newest first), so a burst of more
/// than a page between polls is still read in full, within reason.
const MAX_PAGES: usize = 20;

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
    /// Only what arrives after the first poll: what that poll finds is
    /// skipped, so the local clock never matters.
    Now,
    /// Requests received at or after this server time (ms).
    At(i64),
}

fn parse_since(since: Option<&str>, now_ms: i64) -> Result<Since> {
    let Some(since) = since.map(str::trim) else {
        return Ok(Since::At(now_ms - LOOKBACK_MS));
    };
    if since.eq_ignore_ascii_case("now") {
        return Ok(Since::Now);
    }
    // A bare number is a timestamp, as for the other --since flags.
    if let Ok(at) = since.parse::<i64>() {
        return Ok(Since::At(at));
    }
    let back = parse_duration(since).map_err(|e| {
        CliError::Usage(format!(
            "--since takes \"now\", a duration such as 2m, or a timestamp in ms ({e})"
        ))
    })?;
    Ok(Since::At(now_ms - back))
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

fn received_at(request: &Value) -> Option<i64> {
    request.get("receivedAt").and_then(Value::as_i64)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Whether a failed poll is worth another try: rate limits, our side, the
/// network. A missing endpoint or refused credentials end the wait.
fn transient(error: &anyhow::Error) -> bool {
    matches!(
        classify(error).code,
        "rate_limited" | "server_error" | "network_error" | "request_timeout"
    )
}

pub async fn run(client: &ApiClient, options: WaitOptions, json: bool) -> Result<()> {
    client.require_auth()?;
    let timeout_ms =
        parse_duration(&options.timeout).map_err(|e| CliError::Usage(format!("--timeout: {e}")))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
    let filter = Filter {
        method: options.method.clone(),
        kind: options.kind,
        path: options.path.clone(),
    };
    let count = options.count.max(1) as usize;
    let slug = options.slug.as_str();

    let since = parse_since(options.since.as_deref(), now_ms())?;
    let mut skip_first = since == Since::Now;
    let mut last_checked = match since {
        Since::Now => now_ms() - LOOKBACK_MS,
        Since::At(at) => at,
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut collected: Vec<Value> = Vec::new();

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

    loop {
        let mut pause = POLL;
        let kind = filter.kind.map(|k| match k {
            Kind::Http => "http",
            Kind::Email => "email",
        });
        let fetched = poll_since(
            |cursor| async move {
                client
                    .requests_page_raw(slug, PAGE, cursor.as_deref(), kind)
                    .await
            },
            last_checked,
            MAX_PAGES,
        )
        .await;
        match fetched {
            Ok(mut items) => {
                items.sort_by_key(|r| received_at(r).unwrap_or(0));
                for item in &items {
                    if let Some(at) = received_at(item) {
                        last_checked = last_checked.max(at - OVERLAP_MS);
                    }
                }
                for item in items {
                    let Some(id) = request_id(&item) else {
                        continue;
                    };
                    if !seen.insert(id) || skip_first || !filter.matches(&item) {
                        continue;
                    }
                    collected.push(item);
                    if collected.len() >= count {
                        return print(&collected, count, json);
                    }
                }
                skip_first = false;
            }
            Err(error) if transient(&error) => {
                if let Some(seconds) = classify(&error).retry_after {
                    pause = pause.max(Duration::from_secs(seconds));
                }
            }
            Err(error) => return Err(error),
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(CliError::Timeout(format!(
                "{} of {count} matching request(s) arrived at {slug} within {}",
                collected.len(),
                options.timeout
            ))
            .into());
        }
        tokio::time::sleep(left.min(pause)).await;
    }
}

/// The requests received at or after `since`: the newest page, then older
/// pages until one reaches back past `since` (or the pages run out), so
/// nothing between the last poll and this one is skipped however many
/// arrived. Stops after `max_pages`.
async fn poll_since<F, Fut>(mut fetch: F, since: i64, max_pages: usize) -> Result<Vec<Value>>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<Value>, Option<String>)>>,
{
    let mut out = Vec::new();
    let mut cursor = None;
    for _ in 0..max_pages.max(1) {
        let (items, next) = fetch(cursor.take()).await?;
        let mut reached = items.is_empty();
        for item in items {
            match received_at(&item) {
                Some(at) if at < since => reached = true,
                _ => out.push(item),
            }
        }
        match next {
            Some(next) if !reached => cursor = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

fn print(collected: &[Value], count: usize, json: bool) -> Result<()> {
    if json {
        let out = if count == 1 {
            collected[0].clone()
        } else {
            Value::Array(collected.to_vec())
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    let parsed: Vec<CapturedRequest> = collected
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
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
        let now = 1_000_000_000;
        assert_eq!(
            parse_since(None, now).unwrap(),
            Since::At(now - LOOKBACK_MS)
        );
        assert_eq!(parse_since(Some("now"), now).unwrap(), Since::Now);
        assert_eq!(
            parse_since(Some("2m"), now).unwrap(),
            Since::At(now - 120_000)
        );
        assert_eq!(
            parse_since(Some("1774866106592"), now).unwrap(),
            Since::At(1774866106592)
        );
        let error = parse_since(Some("soon"), now).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[tokio::test]
    async fn a_poll_pages_back_to_where_the_last_one_stopped() {
        // 250 requests since the last poll, newest first, in pages of 100.
        let all: Vec<Value> = (0..300)
            .rev()
            .map(|i| json!({"id": format!("r{i}"), "receivedAt": 1_000 + i}))
            .collect();
        let calls = std::cell::Cell::new(0);
        let fetch = |cursor: Option<String>| {
            calls.set(calls.get() + 1);
            let start: usize = cursor.map(|c| c.parse().unwrap()).unwrap_or(0);
            let page = all[start..(start + 100).min(all.len())].to_vec();
            let next = (start + 100 < all.len()).then(|| (start + 100).to_string());
            async move { Ok((page, next)) }
        };
        let items = poll_since(fetch, 1_050, 20).await.unwrap();
        assert_eq!(items.len(), 250);
        assert_eq!(calls.get(), 3, "stops once a page reaches back past since");
        assert!(items.iter().all(|r| received_at(r).unwrap() >= 1_050));

        // One page that does not fill is one call.
        calls.set(0);
        let fetch = |_: Option<String>| {
            calls.set(calls.get() + 1);
            async { Ok((vec![json!({"id":"a","receivedAt":5})], None)) }
        };
        assert_eq!(poll_since(fetch, 0, 20).await.unwrap().len(), 1);
        assert_eq!(calls.get(), 1);
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
