use anyhow::Result;

use crate::api::ApiClient;
use crate::api::requests::{SEARCH_DEADLINE, SearchFilters, SearchPage};
use crate::cli::ExportFormat;
use crate::cli::output::{
    bold, dim, green, print_request_detail, print_request_line, print_search_hit,
};
use crate::types::CountResult;
use crate::util::format::format_timestamp;

pub async fn list(
    client: &ApiClient,
    slug: &str,
    limit: u32,
    since: Option<i64>,
    cursor: Option<String>,
    json: bool,
) -> Result<()> {
    if let Some(ref c) = cursor {
        let result = client
            .list_requests_paginated(slug, Some(limit), Some(c))
            .await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result.raw)?);
            return Ok(());
        }
        if result.requests.is_empty() {
            println!("  No requests found.");
            return Ok(());
        }
        for req in &result.requests {
            print_request_line(req);
        }
        if let Some(ref next) = result.next_cursor
            && result.has_more != Some(false)
        {
            println!("\n  {} --cursor {}", dim("Next page:"), next);
        }
    } else {
        let result = client.list_requests(slug, Some(limit), since).await?;
        if json {
            println!("{}", serde_json::to_string_pretty(&result.json())?);
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
            println!(
                "\n  {} {count} total",
                dim(&format!("Showing up to {limit} of"))
            );
        }
    }
    Ok(())
}

pub async fn get(client: &ApiClient, id: &str, json: bool) -> Result<()> {
    let req = client.get_request(id).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&req.json())?);
    } else {
        print_request_detail(&req);
    }
    Ok(())
}

/// `whk requests search`: follows the cursor until it has `limit` matches,
/// the whole range was read, or the deadline passed. `--json` prints the
/// matches as one array; how far the search read goes to stderr.
#[allow(clippy::too_many_arguments)]
pub async fn search(
    client: &ApiClient,
    filters: &SearchFilters<'_>,
    limit: u32,
    offset: u32,
    order: &str,
    cursor: Option<&str>,
    api_url: Option<&str>,
    json: bool,
) -> Result<()> {
    let limit = limit.max(1);
    let (from, to) = resolve_times(filters, now_ms());
    let filters = &SearchFilters {
        from: from.as_deref(),
        to: to.as_deref(),
        ..*filters
    };
    let result = client
        .search_requests(filters, limit, offset, order, cursor, SEARCH_DEADLINE)
        .await?;
    let next = (!result.complete)
        .then(|| {
            result
                .cursor
                .as_deref()
                .map(|c| continue_command("search", filters, Some((limit, order)), c, api_url))
        })
        .flatten();

    if json {
        println!("{}", serde_json::to_string_pretty(&result.raw)?);
        if !result.complete {
            eprintln!("{}", search_progress_json(&result, next.as_deref()));
        }
        return Ok(());
    }

    if result.requests.is_empty() {
        println!("  No matching requests found.");
    } else {
        for hit in &result.requests {
            print_search_hit(hit);
        }
        println!("\n  {} {}", dim("Shown:"), result.requests.len());
    }
    if !result.complete {
        eprintln!(
            "  {}",
            search_progress_line(result.searched_until, order, next.as_deref())
        );
    }

    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `--from` and `--to` with durations ("1h": an hour ago) turned into epoch
/// ms once, so every page of a search, and the command that continues it,
/// reads the same range. The server would count a duration back from each
/// request's own time.
fn resolve_times(filters: &SearchFilters<'_>, now: i64) -> (Option<String>, Option<String>) {
    (
        filters.from.map(|v| resolve_time(v, now)),
        filters.to.map(|v| resolve_time(v, now)),
    )
}

/// A duration (the server's grammar: a number, an optional fraction, then
/// ms, s, m, h or d) as the time that long before `now`; anything else as it
/// is, for the server to read or refuse.
fn resolve_time(value: &str, now: i64) -> String {
    let trimmed = value.trim();
    let split = trimmed
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(trimmed.len());
    let (number, unit) = trimmed.split_at(split);
    let unit_ms = match unit.trim_start() {
        "ms" => 1.0,
        "s" => 1_000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => return value.to_string(),
    };
    // Digits, or digits with one fraction: "1.5", never ".5" or "1.".
    let well_formed = match number.split_once('.') {
        Some((whole, fraction)) => {
            !whole.is_empty() && !fraction.is_empty() && !fraction.contains('.')
        }
        None => !number.is_empty(),
    };
    match number.parse::<f64>() {
        Ok(n) if well_formed && (n * unit_ms).is_finite() => {
            ((now as f64 - n * unit_ms).floor().max(0.0) as i64).to_string()
        }
        _ => value.to_string(),
    }
}

/// What `--json` writes to stderr when a search stopped before the end.
fn search_progress_json(result: &SearchPage, next: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "search": {
            "complete": result.complete,
            "searchedUntil": result.searched_until,
            "cursor": result.cursor,
            "continue": next,
        }
    })
}

/// "back to" for a search from the newest, "up to" for one from the oldest.
fn searched_to(searched_until: Option<i64>, order: &str) -> Option<String> {
    let direction = if order == "asc" { "up to" } else { "back to" };
    searched_until.map(|ms| format!("{direction} {}", format_timestamp(ms)))
}

fn search_progress_line(searched_until: Option<i64>, order: &str, next: Option<&str>) -> String {
    let rest = if order == "asc" { "newer" } else { "older" };
    let mut line = match searched_to(searched_until, order) {
        Some(to) => format!("Searched {to}; {rest} requests were not searched."),
        None => format!("The search stopped early; {rest} requests were not searched."),
    };
    if let Some(next) = next {
        line.push_str(&format!(" Continue with: {next}"));
    }
    line
}

/// The command that goes on from `cursor`, with the same filters and the
/// `--api-url` this run used (the default included), so the cursor goes back
/// to the server that made it whatever the later run's environment. Values
/// are attached with `=`, so one that starts with a hyphen is still read as a
/// value.
fn continue_command(
    action: &str,
    filters: &SearchFilters<'_>,
    page: Option<(u32, &str)>,
    cursor: &str,
    api_url: Option<&str>,
) -> String {
    let mut parts = vec![format!("whk requests {action}")];
    for (flag, value) in [
        ("--api-url", api_url),
        ("--slug", filters.slug),
        ("--method", filters.method),
        ("--kind", filters.kind),
        ("-q", filters.query),
        ("--from", filters.from),
        ("--to", filters.to),
    ] {
        if let Some(v) = value {
            parts.push(format!("{flag}={}", shell_word(v)));
        }
    }
    if let Some((limit, order)) = page {
        if limit != 50 {
            parts.push(format!("--limit={limit}"));
        }
        if order != "desc" {
            parts.push(format!("--order={}", shell_word(order)));
        }
    }
    parts.push(format!("--cursor={}", shell_word(cursor)));
    parts.join(" ")
}

/// `s` as one shell word: as it is when plain, else in single quotes.
fn shell_word(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./:=@%+,".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", shell_escape(s))
    }
}

/// `whk requests count`: adds the counts up along the cursor until the count
/// is exact or the deadline passed.
pub async fn count(
    client: &ApiClient,
    filters: &SearchFilters<'_>,
    cursor: Option<&str>,
    api_url: Option<&str>,
    json: bool,
) -> Result<()> {
    let (from, to) = resolve_times(filters, now_ms());
    let filters = &SearchFilters {
        from: from.as_deref(),
        to: to.as_deref(),
        ..*filters
    };
    let result = client
        .count_requests(filters, cursor, SEARCH_DEADLINE)
        .await?;
    let next = (!result.exact)
        .then(|| {
            result
                .cursor
                .as_deref()
                .map(|c| continue_command("count", filters, None, c, api_url))
        })
        .flatten();

    if json {
        println!("{}", count_json(&result, filters));
        if !result.exact {
            eprintln!("{}", count_progress_json(&result, next.as_deref()));
        }
        return Ok(());
    }
    println!("  {}", count_line(&result));
    if let Some(next) = next {
        eprintln!("  Count the rest (add it to this) with: {next}");
    }
    Ok(())
}

/// What `count --json` prints: the count, and the window it counted as the
/// times this run used (`--from 1h` is an hour before it started), so a
/// later run can count the same window on.
fn count_json(result: &CountResult, filters: &SearchFilters<'_>) -> serde_json::Value {
    serde_json::json!({
        "count": result.count,
        "exact": result.exact,
        "searchedUntil": result.searched_until,
        "cursor": result.cursor,
        "from": filters.from.and_then(time_ms),
        "to": filters.to.and_then(time_ms),
    })
}

/// A resolved `--from` or `--to` as epoch ms.
fn time_ms(value: &str) -> Option<i64> {
    let ms: f64 = value.trim().parse().ok()?;
    (ms.is_finite() && ms >= 0.0).then(|| ms.floor() as i64)
}

/// What `--json` writes to stderr when a count stopped before the end.
fn count_progress_json(result: &CountResult, next: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "count": {
            "exact": result.exact,
            "searchedUntil": result.searched_until,
            "cursor": result.cursor,
            "continue": next,
        }
    })
}

fn count_line(result: &CountResult) -> String {
    if result.exact {
        return format!("{} {}", bold("Count:"), result.count);
    }
    match searched_to(result.searched_until, "desc") {
        Some(to) => format!(
            "{} at least {} (searched {to})",
            bold("Count:"),
            result.count
        ),
        None => format!("{} at least {}", bold("Count:"), result.count),
    }
}

pub async fn clear(
    client: &ApiClient,
    slug: &str,
    before: Option<&str>,
    force: bool,
    json: bool,
) -> Result<()> {
    let question = match before {
        Some(b) => format!("Clear requests for {slug} before {b}?"),
        None => format!("Clear ALL requests for {slug}?"),
    };
    crate::cli::confirm::confirm(&question, force)?;

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

    serde_json::to_string_pretty(&har).unwrap_or_else(|_| "{}".to_string())
}

fn build_curl_export(base_url: &str, requests: &[crate::types::CapturedRequest]) -> String {
    let sensitive = [
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
    ];

    requests
        .iter()
        .map(|r| {
            let url = format!("{}{}", base_url, r.path);
            let mut parts = vec![format!("curl -X {}", shell_escape(&r.method))];

            for (k, v) in &r.headers {
                if sensitive.contains(&k.to_lowercase().as_str()) {
                    continue;
                }
                parts.push(format!("-H '{}: {}'", shell_escape(k), shell_escape(v)));
            }

            if let Some(ref body) = r.body {
                parts.push(format!("-d '{}'", shell_escape(body)));
            }

            parts.push(format!("'{}'", shell_escape(&url)));
            parts.join(" \\\n  ")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn shell_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

#[cfg(test)]
mod search_output_tests {
    use super::*;
    use serde_json::json;

    fn filters() -> SearchFilters<'static> {
        SearchFilters {
            slug: Some("abc"),
            query: Some("it's paid"),
            from: Some("7d"),
            ..SearchFilters::default()
        }
    }

    #[test]
    fn the_continue_command_repeats_the_filters() {
        assert_eq!(
            continue_command("search", &filters(), Some((50, "desc")), "abc.def", None),
            r"whk requests search --slug=abc -q='it'\''s paid' --from=7d --cursor=abc.def"
        );
        assert_eq!(
            continue_command(
                "search",
                &SearchFilters::default(),
                Some((20, "asc")),
                "c",
                None
            ),
            "whk requests search --limit=20 --order=asc --cursor=c"
        );
        assert_eq!(
            continue_command("count", &filters(), None, "c", None),
            r"whk requests count --slug=abc -q='it'\''s paid' --from=7d --cursor=c"
        );
        // A value that starts with a hyphen stays a value.
        let dashed = SearchFilters {
            query: Some("--boundary"),
            ..SearchFilters::default()
        };
        assert_eq!(
            continue_command("search", &dashed, Some((50, "desc")), "-c", None),
            "whk requests search -q=--boundary --cursor=-c"
        );
    }

    #[test]
    fn the_continue_command_names_a_server_given_by_flag() {
        assert_eq!(
            continue_command(
                "count",
                &SearchFilters::default(),
                None,
                "c",
                Some("http://localhost:3110")
            ),
            "whk requests count --api-url=http://localhost:3110 --cursor=c"
        );
    }

    #[test]
    fn durations_become_times_once() {
        let now = 1_700_000_000_000;
        assert_eq!(resolve_time("1h", now), "1699996400000");
        assert_eq!(resolve_time("1.5h", now), "1699994600000");
        assert_eq!(resolve_time(" 90 s ", now), "1699999910000");
        assert_eq!(resolve_time("500ms", now), "1699999999500");
        assert_eq!(resolve_time("7d", now), "1699395200000");
        assert_eq!(resolve_time("15m", now), "1699999100000");
        // Longer ago than the epoch is the epoch.
        assert_eq!(resolve_time("99999999d", now), "0");
        // Timestamps and what the server will refuse go as they are.
        for raw in [
            "1699996400000",
            "nonsense",
            "1.h",
            ".5h",
            "1.2.3h",
            "1w",
            "-1h",
            "",
        ] {
            assert_eq!(resolve_time(raw, now), raw);
        }

        let filters = SearchFilters {
            from: Some("7d"),
            to: Some("1700000000000"),
            ..SearchFilters::default()
        };
        let (from, to) = resolve_times(&filters, now);
        let resolved = SearchFilters {
            from: from.as_deref(),
            to: to.as_deref(),
            ..filters
        };
        assert_eq!(
            continue_command("search", &resolved, Some((500, "desc")), "c", None),
            "whk requests search --from=1699395200000 --to=1700000000000 --limit=500 --cursor=c"
        );
    }

    #[test]
    fn an_unfinished_search_says_how_far_it_read() {
        let time = format_timestamp(1_700_000_000_000);
        assert_eq!(
            search_progress_line(Some(1_700_000_000_000), "desc", Some("whk x")),
            format!(
                "Searched back to {time}; older requests were not searched. Continue with: whk x"
            )
        );
        assert_eq!(
            search_progress_line(Some(1_700_000_000_000), "asc", None),
            format!("Searched up to {time}; newer requests were not searched.")
        );
        assert!(search_progress_line(None, "desc", None).starts_with("The search stopped early"));

        let page = SearchPage {
            requests: vec![],
            raw: vec![],
            complete: false,
            searched_until: Some(5),
            cursor: Some("c".into()),
        };
        assert_eq!(
            search_progress_json(&page, Some("whk x")),
            json!({"search": {"complete": false, "searchedUntil": 5, "cursor": "c", "continue": "whk x"}})
        );
    }

    #[test]
    fn a_count_prints_exact_or_at_least() {
        crate::cli::output::set_no_color(true);
        let mut result = CountResult {
            count: 7,
            exact: true,
            searched_until: None,
            cursor: None,
        };
        assert_eq!(count_line(&result), "Count: 7");
        assert_eq!(
            count_json(&result, &SearchFilters::default()),
            json!({"count": 7, "exact": true, "searchedUntil": null, "cursor": null,
                "from": null, "to": null})
        );

        result.exact = false;
        result.searched_until = Some(1_700_000_000_000);
        result.cursor = Some("c".into());
        assert_eq!(
            count_line(&result),
            format!(
                "Count: at least 7 (searched back to {})",
                format_timestamp(1_700_000_000_000)
            )
        );
        assert_eq!(
            count_json(
                &result,
                &SearchFilters {
                    from: Some("1699395200000"),
                    to: Some("nonsense"),
                    ..SearchFilters::default()
                }
            ),
            json!({"count": 7, "exact": false, "searchedUntil": 1_700_000_000_000_i64, "cursor": "c",
                "from": 1_699_395_200_000_i64, "to": null})
        );
        assert_eq!(
            count_progress_json(&result, Some("whk x")),
            json!({"count": {"exact": false, "searchedUntil": 1_700_000_000_000_i64,
                "cursor": "c", "continue": "whk x"}})
        );
    }
}
