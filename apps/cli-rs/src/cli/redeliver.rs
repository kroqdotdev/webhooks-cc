//! `whk requests replay` and `whk requests replay-range`: run captured
//! requests through their endpoint again on the server, with its current
//! settings. An email on an endpoint with layouts is parsed again first (its
//! attachments' stored parses are reused, so no pages are used twice), then
//! every destination that takes its kind gets it again. For after a pattern
//! was fixed or a destination came back. Owner only.
//!
//! `whk replay --to <url>` is the other replay: it sends a request from this
//! machine to a URL you name, such as localhost.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::api::ApiClient;
use crate::cli::confirm::confirm;
use crate::cli::output::{bold, dim, green, sanitize_line};
use crate::error::CliError;
use crate::util::format::{format_timestamp, parse_duration};

fn print_json(answer: &crate::api::client::Fetched<Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&answer.json())?);
    Ok(())
}

pub async fn one(client: &ApiClient, request_id: &str, yes: bool, json: bool) -> Result<()> {
    let request_id = request_id.trim();
    confirm(
        &format!(
            "Run request {request_id} through its endpoint again now (layouts, then every destination that takes it)?"
        ),
        yes,
    )?;
    let answer = client.replay_request(request_id).await?;
    if json {
        return print_json(&answer);
    }
    if answer.value.get("queued").and_then(Value::as_bool) == Some(true) {
        println!("{} Queued {} again", green("✓"), bold(request_id));
        println!(
            "  {}",
            dim("`whk deliveries ls --request <id>` shows how its deliveries go.")
        );
    } else {
        println!(
            "  Nothing was queued: no destination of its endpoint takes this kind of request now."
        );
    }
    Ok(())
}

/// A point in time: epoch milliseconds, or a duration back from `now`
/// ("2h": two hours ago).
fn point(flag: &str, value: &str, now: i64) -> Result<i64> {
    let value = value.trim();
    if let Ok(ms) = value.parse::<i64>() {
        if ms < 0 {
            return Err(CliError::Usage(format!("{flag} cannot be before 1970")).into());
        }
        return Ok(ms);
    }
    match parse_duration(value) {
        Ok(back) => Ok((now - back).max(0)),
        Err(_) => Err(CliError::Usage(format!(
            "{flag} takes a time in epoch milliseconds, or a duration back from now such as 2h or 7d"
        ))
        .into()),
    }
}

/// The body for a range: `since` and `until` in ms, and the kind.
pub fn range_body(
    since: Option<&str>,
    until: Option<&str>,
    kind: Option<&str>,
    now: i64,
) -> Result<Value> {
    let mut body = Map::new();
    let since = since.map(|v| point("--since", v, now)).transpose()?;
    let until = until.map(|v| point("--until", v, now)).transpose()?;
    if let (Some(since), Some(until)) = (since, until)
        && since > until
    {
        return Err(CliError::Usage("--since is after --until".into()).into());
    }
    if let Some(since) = since {
        body.insert("since".into(), json!(since));
    }
    if let Some(until) = until {
        body.insert("until".into(), json!(until));
    }
    if let Some(kind) = kind {
        body.insert("kind".into(), json!(kind));
    }
    Ok(Value::Object(body))
}

fn range_words(body: &Value) -> String {
    let at = |field: &str| {
        body.get(field)
            .and_then(Value::as_i64)
            .map(format_timestamp)
    };
    let what = match body.get("kind").and_then(Value::as_str) {
        Some("email") => "emails",
        Some("http") => "HTTP requests",
        _ => "requests",
    };
    match (at("since"), at("until")) {
        (Some(since), Some(until)) => format!("{what} from {since} to {until}"),
        (Some(since), None) => format!("{what} since {since}"),
        (None, Some(until)) => format!("{what} up to {until}"),
        (None, None) => format!("all its {what}"),
    }
}

pub async fn range(
    client: &ApiClient,
    slug: &str,
    since: Option<&str>,
    until: Option<&str>,
    kind: Option<&str>,
    yes: bool,
    json: bool,
) -> Result<()> {
    let body = range_body(since, until, kind, chrono::Utc::now().timestamp_millis())?;
    confirm(
        &format!(
            "Run {} of {slug} through it again now, oldest first, at most 500?",
            range_words(&body)
        ),
        yes,
    )?;
    let answer = client.replay_range(slug, &body).await?;
    if json {
        return print_json(&answer);
    }
    let count = |field: &str| answer.value.get(field).and_then(Value::as_u64).unwrap_or(0);
    let found = count("requests");
    println!(
        "{} Queued {} of {found} request{} of {} again",
        green("✓"),
        count("queued"),
        if found == 1 { "" } else { "s" },
        bold(&sanitize_line(slug))
    );
    let limit = count("limit");
    if limit > 0 && found >= limit {
        println!(
            "  {}",
            dim(&format!(
                "That is the most one call takes ({limit}): run it again from after the last one for the rest."
            ))
        );
    }
    if count("queued") < found {
        println!(
            "  {}",
            dim("The rest have no destination that takes their kind now.")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_range_takes_times_or_durations() {
        assert_eq!(range_body(None, None, None, NOW).unwrap(), json!({}));
        let body = range_body(Some("2h"), Some("1799999999000"), Some("email"), NOW).unwrap();
        assert_eq!(
            body,
            json!({ "since": NOW - 7_200_000, "until": 1_799_999_999_000i64, "kind": "email" })
        );
    }

    #[test]
    fn a_range_must_make_sense() {
        for (since, until) in [
            (Some("yesterday"), None),
            (Some("-5"), None),
            (Some("1h"), Some("2h")),
        ] {
            let error = range_body(since, until, None, NOW).unwrap_err();
            assert_eq!(classify(&error).code, "usage", "{since:?} {until:?}");
        }
    }

    #[test]
    fn the_question_names_the_range() {
        assert_eq!(range_words(&json!({})), "all its requests");
        assert!(
            range_words(&json!({ "since": 0, "kind": "http" })).starts_with("HTTP requests since")
        );
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
    async fn replays_through_the_server() {
        let sent: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let (one_seen, range_seen) = (sent.clone(), sent.clone());
        let app = axum::Router::new()
            .route(
                "/api/requests/{id}/replay",
                axum::routing::post(
                    move |axum::extract::Path(id): axum::extract::Path<String>| async move {
                        one_seen.lock().unwrap().push(format!("one {id}"));
                        axum::Json(json!({ "queued": true }))
                    },
                ),
            )
            .route(
                "/api/endpoints/{slug}/replay",
                axum::routing::post(
                    move |axum::extract::Path(slug): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<Value>| async move {
                        range_seen
                            .lock()
                            .unwrap()
                            .push(format!("range {slug} {body}"));
                        axum::Json(json!({ "requests": 3, "queued": 2, "limit": 500 }))
                    },
                ),
            );
        let base = serve(app).await;
        one(&client(&base), "r1", true, true).await.unwrap();
        range(
            &client(&base),
            "acme",
            None,
            None,
            Some("http"),
            true,
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            *sent.lock().unwrap(),
            vec![
                "one r1".to_string(),
                "range acme {\"kind\":\"http\"}".to_string()
            ]
        );
    }
}
