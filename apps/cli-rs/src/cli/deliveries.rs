//! `whk deliveries`: the delivery log of an endpoint's destinations, or of
//! one captured request, its counts, and sending requests again. Owner only
//! (a team member reading one request's deliveries sees the hosts only).

use anyhow::Result;
use serde_json::Value;

use crate::api::ApiClient;
use crate::api::destinations::DeliveryQuery;
use crate::cli::confirm::confirm;
use crate::cli::destinations::when;
use crate::cli::output::{bold, dim, green, red, sanitize_line};

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn print_json(answer: &crate::api::client::Fetched<Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&answer.json())?);
    Ok(())
}

fn status_label(status: &str) -> String {
    let padded = format!("{status:<9}");
    match status {
        "succeeded" => green(&padded),
        "failed" => red(&padded),
        _ => padded,
    }
}

/// The destination by its name, else the host of its URL.
fn destination_label(delivery: &Value) -> String {
    let Some(destination) = delivery.get("destination").filter(|d| !d.is_null()) else {
        return "-".into();
    };
    let name = text(destination, "name");
    if !name.is_empty() {
        return sanitize_line(name);
    }
    let url = text(destination, "url");
    let host = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    sanitize_line(host)
}

/// What was delivered: the email's subject, or the request's method and path.
fn what(delivery: &Value) -> String {
    let subject = text(delivery, "subject");
    if text(delivery, "kind") == "email" || !subject.is_empty() {
        return format!("email \"{}\"", sanitize_line(subject));
    }
    let method = text(delivery, "method");
    if method.is_empty() {
        return "-".into();
    }
    format!(
        "{} {}",
        sanitize_line(method),
        sanitize_line(text(delivery, "path"))
    )
}

fn last_status(delivery: &Value) -> String {
    delivery
        .get("lastStatus")
        .and_then(Value::as_u64)
        .map_or_else(|| "-".into(), |s| s.to_string())
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut out: String = text.chars().take(width.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The destination's id, which `redeliver --destination` takes.
fn destination_id(delivery: &Value) -> String {
    delivery
        .get("destination")
        .map(|d| text(d, "id"))
        .filter(|id| !id.is_empty())
        .map_or_else(|| "-".into(), sanitize_line)
}

fn log_lines(list: &[Value]) -> Vec<String> {
    // The two ids end the row, so a failed one leads straight to
    // `whk deliveries redeliver <request-id> --destination <destination-id>`.
    let mut out = vec![format!(
        "  {}",
        dim(&format!(
            "{:<9} {:<5} {:<5} {:<19} {:<18} {:<26} {:<36} {}",
            "STATUS", "TRIES", "LAST", "QUEUED", "TO", "WHAT", "REQUEST", "DESTINATION"
        ))
    )];
    let mut failed = false;
    for delivery in list {
        let request = sanitize_line(text(delivery, "requestId"));
        out.push(format!(
            "  {} {:<5} {:<5} {:<19} {:<18} {:<26} {} {}",
            status_label(text(delivery, "status")),
            delivery
                .get("attempts")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            last_status(delivery),
            when(delivery, "createdAt"),
            truncate(&destination_label(delivery), 18),
            truncate(&what(delivery), 26),
            dim(&format!("{request:<36}")),
            dim(&destination_id(delivery)),
        ));
        if let Some(error) = delivery.get("lastError").and_then(Value::as_str)
            && text(delivery, "status") != "succeeded"
        {
            out.push(format!("    {}", dim(&sanitize_line(error))));
        }
        failed |= text(delivery, "status") == "failed";
    }
    if failed {
        out.push(String::new());
        out.push(format!(
            "  {} whk deliveries redeliver <request> --destination <destination>",
            dim("Send one again:")
        ));
    }
    out
}

/// One request's deliveries, each with its tries.
fn request_lines(list: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for delivery in list {
        let target = text(delivery, "target");
        out.push(format!(
            "  {} {}{} {}",
            status_label(text(delivery, "status")),
            bold(&destination_label(delivery)),
            if target.is_empty() {
                String::new()
            } else {
                format!(" {}", sanitize_line(target))
            },
            dim(text(delivery, "id")),
        ));
        if let Some(next) = delivery.get("nextAttemptAt").and_then(Value::as_i64)
            && text(delivery, "status") == "pending"
        {
            out.push(format!(
                "    {} {}",
                dim("next try"),
                crate::util::format::format_timestamp(next)
            ));
        }
        for attempt in delivery
            .get("attemptLog")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let status = attempt
                .get("status")
                .and_then(Value::as_u64)
                .map_or_else(|| "-".into(), |s| s.to_string());
            let ms = attempt
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let detail = attempt
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| attempt.get("responseExcerpt").and_then(Value::as_str))
                .map(|d| sanitize_line(&truncate(d, 80)))
                .unwrap_or_default();
            out.push(format!(
                "    {}  {:<4} {:>6} ms  {}",
                when(attempt, "attemptedAt"),
                status,
                ms,
                dim(&detail)
            ));
        }
    }
    out
}

pub async fn list(
    client: &ApiClient,
    slug: Option<&str>,
    request: Option<&str>,
    query: &DeliveryQuery,
    json: bool,
) -> Result<()> {
    if let Some(request) = request {
        let answer = client.request_deliveries(request.trim()).await?;
        if json {
            return print_json(&answer);
        }
        let list = answer.value.as_array().cloned().unwrap_or_default();
        if list.is_empty() {
            println!("  No deliveries of this request.");
            return Ok(());
        }
        for line in request_lines(&list) {
            println!("{line}");
        }
        return Ok(());
    }
    let slug = slug.unwrap_or_default();
    let answer = client.list_deliveries(slug, query).await?;
    if json {
        return print_json(&answer);
    }
    let list = answer.value.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("  No deliveries.");
        return Ok(());
    }
    for line in log_lines(&list) {
        println!("{line}");
    }
    if let Some(next) = older_command(slug, query, &list) {
        println!("\n  {} {next}", dim("Older:"));
    }
    Ok(())
}

/// The command for the next page, with the same filters, when this page is full.
fn older_command(slug: &str, query: &DeliveryQuery, list: &[Value]) -> Option<String> {
    let limit = query.limit.unwrap_or(5);
    if list.len() < limit as usize {
        return None;
    }
    let cursor = list.last()?.get("cursor")?.as_str()?;
    let mut command = format!("whk deliveries ls {} --limit {limit}", sanitize_line(slug));
    if let Some(status) = &query.status {
        command.push_str(&format!(" --status {}", sanitize_line(status)));
    }
    if let Some(destination) = &query.destination {
        command.push_str(&format!(" --destination {}", sanitize_line(destination)));
    }
    // The cursor holds a timestamp and a `|`: quoted for the shell.
    command.push_str(&format!(
        " --before '{}'",
        sanitize_line(cursor).replace('\'', "")
    ));
    Some(command)
}

pub async fn summary(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let answer = client.delivery_summary(slug).await?;
    if json {
        return print_json(&answer);
    }
    for line in summary_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

fn summary_lines(s: &Value) -> Vec<String> {
    let count = |v: Option<&Value>| v.and_then(Value::as_u64).unwrap_or(0);
    let day = s.get("last24h");
    vec![
        format!(
            "  {} {} delivered, {} failed",
            dim(&format!("{:<14}", "Last 24 hours")),
            count(day.and_then(|d| d.get("delivered"))),
            count(day.and_then(|d| d.get("failed")))
        ),
        format!(
            "  {} {}",
            dim(&format!("{:<14}", "Waiting")),
            count(s.get("pending"))
        ),
        format!(
            "  {} {} of {} kept",
            dim(&format!("{:<14}", "Failed")),
            count(s.get("failed")),
            count(s.get("total"))
        ),
    ]
}

pub async fn redeliver(
    client: &ApiClient,
    request_id: &str,
    destination: Option<&str>,
    yes: bool,
    json: bool,
) -> Result<()> {
    let request_id = request_id.trim();
    let question = match destination {
        Some(id) => format!(
            "Send request {request_id} to destination {} again now, whatever its filter says?",
            id.trim()
        ),
        None => format!(
            "Send request {request_id} again now, to every destination that takes its kind?"
        ),
    };
    confirm(&question, yes)?;
    let answer = client
        .redeliver_request(request_id, destination.map(str::trim))
        .await
        .map_err(|error| maybe_queued(error, request_id))?;
    if json {
        return print_json(&answer);
    }
    println!(
        "{} Queued {} {}",
        green("✓"),
        bold(request_id),
        dim(&format!("(delivery {})", text(&answer.value, "id")))
    );
    println!(
        "  {}",
        dim(
            "It goes with each destination's current settings; `whk deliveries ls --request <id>` shows how it went."
        )
    );
    Ok(())
}

/// A redelivery whose answer never came may still have been queued, so the
/// error says to look before sending it again.
fn maybe_queued(error: anyhow::Error, request_id: &str) -> anyhow::Error {
    if crate::error::classify(&error).code == "network_error" {
        error.context(format!(
            "No answer came, so it may already be queued: check `whk deliveries ls --request {}` before sending it again",
            sanitize_line(request_id)
        ))
    } else {
        error
    }
}

pub async fn redeliver_failed(
    client: &ApiClient,
    slug: &str,
    destination: Option<&str>,
    yes: bool,
    json: bool,
) -> Result<()> {
    let question = match destination {
        Some(id) => format!(
            "Send every request whose latest delivery to destination {} failed again now?",
            id.trim()
        ),
        None => format!("Send every request of {slug} whose latest delivery failed again now?"),
    };
    confirm(&question, yes)?;
    let answer = client
        .redeliver_failed(slug, destination.map(str::trim))
        .await?;
    if json {
        return print_json(&answer);
    }
    let queued = answer
        .value
        .get("queued")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    println!(
        "{} Queued {queued} deliver{} again",
        green("✓"),
        if queued == 1 { "y" } else { "ies" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_log_names_the_destination_and_what_went() {
        let lines = log_lines(&[
            json!({
                "id": "x1", "requestId": "r1", "kind": "http", "status": "failed",
                "destination": { "id": "d1", "name": null, "url": "https://example.com/hooks?t=secret" },
                "attempts": 3, "createdAt": 1_763_000_000_000_i64, "lastStatus": 502,
                "lastError": "Bad gateway", "method": "POST", "path": "/orders", "subject": null
            }),
            json!({
                "id": "x2", "requestId": "r2", "kind": "email", "status": "succeeded",
                "destination": { "id": "d2", "name": "Zapier", "url": "https://hooks.zapier.com/x" },
                "attempts": 1, "createdAt": 1_763_000_000_000_i64, "lastStatus": 200,
                "lastError": null, "subject": "Order #1001"
            }),
        ])
        .join("\n");
        assert!(lines.contains("example.com "), "{lines}");
        assert!(
            !lines.contains("secret"),
            "the URL's query stays out: {lines}"
        );
        assert!(lines.contains("POST /orders"), "{lines}");
        assert!(lines.contains("502"), "{lines}");
        assert!(lines.contains("Bad gateway"), "{lines}");
        assert!(lines.contains("Zapier"), "{lines}");
        assert!(lines.contains("email \"Order #1001\""), "{lines}");
        let failed_row = lines.lines().nth(1).unwrap();
        assert!(
            failed_row.contains("r1") && failed_row.contains("d1"),
            "the row carries both ids: {failed_row}"
        );
        assert!(
            lines.contains("whk deliveries redeliver <request> --destination <destination>"),
            "{lines}"
        );
    }

    #[test]
    fn a_crafted_subject_cannot_fake_a_row() {
        let lines = log_lines(&[
            json!({
                "id": "x1", "requestId": "r1", "kind": "email", "status": "failed",
                "destination": { "id": "d1", "name": "A\nB", "url": "https://example.com" },
                "attempts": 1, "createdAt": 0, "lastStatus": 500,
                "subject": "x\n  succeeded 1 200"
            }),
            json!({
                "id": "x2", "requestId": "r2", "kind": "http", "status": "succeeded",
                "destination": null, "attempts": 1, "createdAt": 0, "lastStatus": 200,
                "method": "POST", "path": "/a\r\n  failed"
            }),
        ]);
        // The heading, the two rows, and the hint under a failed one.
        assert!(
            lines.iter().all(|l| !l.contains('\n') && !l.contains('\r')),
            "{lines:?}"
        );
        assert_eq!(lines.len(), 1 + 2 + 2, "{lines:?}");
    }

    #[test]
    fn a_request_lists_each_try() {
        let lines = request_lines(&[json!({
            "id": "x1", "requestId": "r1", "status": "pending",
            "destination": { "id": "d1", "name": "Acme", "url": "https://example.com" },
            "target": "example.com/hooks", "attempts": 1, "createdAt": 0,
            "nextAttemptAt": 1_763_000_060_000_i64,
            "attemptLog": [{ "attemptedAt": 1_763_000_000_000_i64, "status": null,
                "durationMs": 15, "error": "connection refused", "responseExcerpt": null }]
        })])
        .join("\n");
        assert!(lines.contains("Acme"), "{lines}");
        assert!(lines.contains("next try"), "{lines}");
        assert!(lines.contains("connection refused"), "{lines}");
    }

    #[test]
    fn the_next_page_keeps_the_filters() {
        let query = DeliveryQuery {
            limit: Some(1),
            status: Some("failed".into()),
            destination: Some("d1".into()),
            before: None,
        };
        let page = [json!({ "id": "x1", "cursor": "2026-11-14T16:45:29.215878+00:00|7497df9f" })];
        assert_eq!(
            older_command("acme", &query, &page).as_deref(),
            Some(
                "whk deliveries ls acme --limit 1 --status failed --destination d1 --before '2026-11-14T16:45:29.215878+00:00|7497df9f'"
            )
        );
        let short = DeliveryQuery {
            limit: Some(5),
            ..query
        };
        assert_eq!(older_command("acme", &short, &page), None);
    }

    #[test]
    fn sums_up_the_counts() {
        let lines = summary_lines(&json!({
            "last24h": { "delivered": 10, "failed": 2 }, "pending": 1, "failed": 4, "total": 40
        }))
        .join("\n");
        assert!(lines.contains("10 delivered, 2 failed"), "{lines}");
        assert!(lines.contains("4 of 40 kept"), "{lines}");
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
    async fn redelivering_to_one_destination_names_it() {
        let sent: std::sync::Arc<std::sync::Mutex<Option<Value>>> = Default::default();
        let seen = sent.clone();
        let app = axum::Router::new().route(
            "/api/requests/{id}/deliveries",
            axum::routing::post(
                move |axum::extract::Path(id): axum::extract::Path<String>,
                      axum::Json(body): axum::Json<Value>| async move {
                    assert_eq!(id, "r1");
                    *seen.lock().unwrap() = Some(body);
                    axum::Json(json!({ "id": "x9" }))
                },
            ),
        );
        let base = serve(app).await;
        redeliver(&client(&base), "r1", Some("d1"), true, true)
            .await
            .unwrap();
        assert_eq!(
            sent.lock().unwrap().clone(),
            Some(json!({ "destinationId": "d1" }))
        );
    }

    #[tokio::test]
    async fn redelivering_failed_ones_passes_the_destination_in_the_query() {
        let seen: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
        let query = seen.clone();
        let app = axum::Router::new().route(
            "/api/endpoints/{slug}/deliveries/redeliver-failed",
            axum::routing::post(
                move |axum::extract::RawQuery(raw): axum::extract::RawQuery| async move {
                    *query.lock().unwrap() = raw;
                    axum::Json(json!({ "queued": 3 }))
                },
            ),
        );
        let base = serve(app).await;
        redeliver_failed(&client(&base), "acme", Some("d1"), true, true)
            .await
            .unwrap();
        assert_eq!(seen.lock().unwrap().as_deref(), Some("destination=d1"));
    }
}
