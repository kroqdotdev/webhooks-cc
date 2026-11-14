use crate::util::url::encode;
use anyhow::{Context, Result};
use reqwest::header::HeaderMap;
use serde_json::Value;
use std::future::Future;
use std::time::{Duration, Instant};

use super::ApiClient;
use super::client::Fetched;
use crate::error::ApiError;
use crate::types::{
    CapturedRequest, CountResult, EmailFormat, PaginatedRequestList, RenderedEmail, RequestList,
    SearchHit, SearchResult,
};

/// How long `whk requests search` and `count` keep following the cursor.
pub const SEARCH_DEADLINE: Duration = Duration::from_secs(25);

/// The most matches one page holds.
const PAGE_MAX: u32 = 200;

/// What a page may run past the deadline.
const PAGE_GRACE: Duration = Duration::from_secs(5);

/// What a search or a count looks for. Every page of one search sends the
/// same filters.
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchFilters<'a> {
    pub slug: Option<&'a str>,
    pub method: Option<&'a str>,
    /// `http` or `email`.
    pub kind: Option<&'a str>,
    pub query: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
}

impl SearchFilters<'_> {
    fn params(&self) -> Vec<String> {
        let mut params = vec!["paged=true".to_string()];
        for (name, value) in [
            ("slug", self.slug),
            ("method", self.method),
            ("kind", self.kind),
            ("q", self.query),
            ("from", self.from),
            ("to", self.to),
        ] {
            if let Some(v) = value {
                params.push(format!("{name}={}", encode(v)));
            }
        }
        params
    }
}

/// Matches and how far the search read: one page, or several merged.
#[derive(Debug, Clone)]
pub struct SearchPage {
    pub requests: Vec<SearchHit>,
    /// The rows as `--json` prints them: the server's own JSON.
    pub raw: Vec<Value>,
    /// The whole range was read.
    pub complete: bool,
    /// How far the search read, in epoch ms.
    pub searched_until: Option<i64>,
    /// Continues the search; none once it is complete.
    pub cursor: Option<String>,
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_string())
}

fn api_error(error: &anyhow::Error) -> Option<&ApiError> {
    error.chain().find_map(|c| c.downcast_ref::<ApiError>())
}

/// The 429 that means too many searches run at once (not the rate limit).
fn is_search_busy(error: &anyhow::Error) -> bool {
    api_error(error).is_some_and(|e| e.status == 429 && e.message.contains("search_busy"))
}

/// The search routes answer with bare codes; say what they mean, keeping the
/// code in the message.
fn explain_search_error(error: anyhow::Error) -> anyhow::Error {
    let Some(e) = api_error(&error) else {
        return error;
    };
    let message = match (e.status, e.message.as_str()) {
        (400, "invalid_cursor") => {
            "That cursor is not one a search returned, or it was made for the other --order (invalid_cursor)."
        }
        (400, "invalid_from") => {
            "--from takes a timestamp in ms or a duration such as 15m, 1h or 7d (invalid_from)."
        }
        (400, "invalid_to") => {
            "--to takes a timestamp in ms or a duration such as 15m, 1h or 7d (invalid_to)."
        }
        (400, "invalid_q") => "The search text is longer than 1,000 characters (invalid_q).",
        (429, "search_busy") => {
            "Too many searches are running, on this account or on the service (search_busy)."
        }
        _ => return error,
    };
    anyhow::Error::new(ApiError {
        status: e.status,
        message: message.to_string(),
        retry_after: e.retry_after,
    })
}

/// A request that ran into its timeout.
fn is_timeout(error: &anyhow::Error) -> bool {
    error.chain().any(|c| {
        c.downcast_ref::<reqwest::Error>()
            .is_some_and(|e| e.is_timeout())
    })
}

/// How long a page may take: what is left until `stop_at` plus a little, so
/// a page started just before the deadline cannot run a full request timeout
/// past it. The client's own timeout still caps it.
fn page_timeout(stop_at: Instant) -> Duration {
    stop_at.saturating_duration_since(Instant::now()) + PAGE_GRACE
}

/// Runs `call` again after `Retry-After` while the answer is `search_busy`
/// and the wait still ends before `stop_at`.
async fn retry_while_busy<T, F, Fut>(stop_at: Instant, mut call: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    loop {
        let error = match call().await {
            Err(e) if is_search_busy(&e) => e,
            other => return other,
        };
        let wait = Duration::from_secs(
            api_error(&error)
                .and_then(|e| e.retry_after)
                .unwrap_or(1)
                .max(1),
        );
        if Instant::now() + wait >= stop_at {
            return Err(error);
        }
        tokio::time::sleep(wait).await;
    }
}

impl ApiClient {
    pub async fn list_requests(
        &self,
        slug: &str,
        limit: Option<u32>,
        since: Option<i64>,
    ) -> Result<Fetched<RequestList>> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(s) = since {
            params.push(format!("since={s}"));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self
            .get(&format!("/api/endpoints/{}/requests{qs}", encode(slug)))
            .await?;
        // API returns a bare array; --json prints it as {"requests": [...]}
        // as it always has.
        let list = resp.parse::<Vec<CapturedRequest>>("request list")?;
        Ok(Fetched {
            value: RequestList {
                count: None,
                requests: list.value,
            },
            raw: serde_json::json!({ "requests": list.raw, "count": null }),
        })
    }

    pub async fn list_requests_paginated(
        &self,
        slug: &str,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<Fetched<PaginatedRequestList>> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(c) = cursor {
            params.push(format!("cursor={}", encode(c)));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self
            .get(&format!(
                "/api/endpoints/{}/requests/paginated{qs}",
                encode(slug)
            ))
            .await?;
        resp.parse("paginated request list")
    }

    pub async fn get_request(&self, request_id: &str) -> Result<Fetched<CapturedRequest>> {
        self.require_auth()?;
        let resp = self
            .get(&format!("/api/requests/{}", encode(request_id)))
            .await?;
        resp.parse("request")
    }

    /// Render a captured email for a handler (`POST /api/requests/{id}/render`):
    /// webhooks.cc's email JSON, or the way an inbound mail provider posts it.
    /// The Mailgun form is signed with `mailgun_signing_key` when one is given.
    pub async fn render_email(
        &self,
        request_id: &str,
        format: EmailFormat,
        mailgun_signing_key: Option<&str>,
    ) -> Result<RenderedEmail> {
        self.require_auth()?;
        let mut body = serde_json::json!({ "format": format });
        if let Some(key) = mailgun_signing_key {
            body["mailgunSigningKey"] = key.into();
        }
        let resp = self
            .post(
                &format!("/api/requests/{}/render", encode(request_id)),
                &body,
            )
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse rendered email")
    }

    /// One page of a search (`paged=true`: the server reads for about two
    /// seconds and says where it stopped). `offset` is for a first page only;
    /// a cursor carries what is left of it. `timeout` shortens the request
    /// timeout.
    pub async fn search_requests_page(
        &self,
        filters: &SearchFilters<'_>,
        limit: Option<u32>,
        offset: Option<u32>,
        order: Option<&str>,
        cursor: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<SearchPage> {
        self.require_auth()?;
        let mut params = filters.params();
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(ord) = order {
            params.push(format!("order={}", encode(ord)));
        }
        match cursor {
            Some(c) => params.push(format!("cursor={}", encode(c))),
            None => {
                if let Some(o) = offset.filter(|o| *o > 0) {
                    params.push(format!("offset={o}"));
                }
            }
        }
        let resp = self
            .get_within(
                &format!("/api/search/requests?{}", params.join("&")),
                timeout,
            )
            .await
            .map_err(explain_search_error)?;
        let list = resp.parse::<SearchResult>("search results")?;
        let raw = match list.json() {
            Value::Array(rows) => rows,
            _ => Vec::new(),
        };
        let cursor = header(&resp.headers, "x-search-cursor").filter(|c| !c.is_empty());
        // A server from before cursors sends no headers: its page is all
        // there is to follow.
        let complete = match header(&resp.headers, "x-search-complete") {
            Some(v) => v.eq_ignore_ascii_case("true"),
            None => cursor.is_none(),
        };
        Ok(SearchPage {
            requests: list.value.requests,
            raw,
            complete,
            searched_until: header(&resp.headers, "x-search-searched-until")
                .and_then(|v| v.parse::<f64>().ok())
                .map(|ms| ms as i64),
            cursor,
        })
    }

    /// A search that follows the cursor itself: until it has `limit` matches,
    /// the whole range was read, or `deadline` has passed. What comes back
    /// says whether it finished, and the cursor to go on from if not.
    pub async fn search_requests(
        &self,
        filters: &SearchFilters<'_>,
        limit: u32,
        offset: u32,
        order: &str,
        cursor: Option<&str>,
        deadline: Duration,
    ) -> Result<SearchPage> {
        let stop_at = Instant::now() + deadline;
        let mut out = SearchPage {
            requests: Vec::new(),
            raw: Vec::new(),
            complete: false,
            searched_until: None,
            cursor: cursor.map(String::from),
        };
        let mut first = true;
        loop {
            // A page holds at most 200; a larger limit takes several.
            let left = limit
                .saturating_sub(out.requests.len() as u32)
                .clamp(1, PAGE_MAX);
            let cursor = out.cursor.clone();
            let page = retry_while_busy(stop_at, || {
                self.search_requests_page(
                    filters,
                    Some(left),
                    first.then_some(offset),
                    Some(order),
                    cursor.as_deref(),
                    Some(page_timeout(stop_at)),
                )
            })
            .await;
            let page = match page {
                Ok(page) => page,
                // Busy for the rest of the time: what was found so far is
                // still worth having, with the cursor to go on from.
                Err(e) if !first && (is_search_busy(&e) || is_timeout(&e)) => break,
                Err(e) => return Err(e),
            };
            first = false;
            out.requests.extend(page.requests);
            out.raw.extend(page.raw);
            out.complete = page.complete;
            out.cursor = page.cursor;
            if page.searched_until.is_some() {
                out.searched_until = page.searched_until;
            }
            if out.complete
                || out.cursor.is_none()
                || out.requests.len() as u32 >= limit
                || Instant::now() >= stop_at
            {
                break;
            }
        }
        if out.complete {
            out.cursor = None;
        }
        Ok(out)
    }

    /// One call to the count route (`paged=true`): the matches in the
    /// stretch it read.
    pub async fn count_requests_page(
        &self,
        filters: &SearchFilters<'_>,
        cursor: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<CountResult> {
        self.require_auth()?;
        let mut params = filters.params();
        if let Some(c) = cursor {
            params.push(format!("cursor={}", encode(c)));
        }
        let resp = self
            .get_within(
                &format!("/api/search/requests/count?{}", params.join("&")),
                timeout,
            )
            .await
            .map_err(explain_search_error)?;
        let mut result: CountResult =
            serde_json::from_str(&resp.body).context("failed to parse count result")?;
        result.cursor = result.cursor.filter(|c| !c.is_empty());
        Ok(result)
    }

    /// A count that follows the cursor and adds the stretches up, until it is
    /// exact or `deadline` has passed.
    pub async fn count_requests(
        &self,
        filters: &SearchFilters<'_>,
        cursor: Option<&str>,
        deadline: Duration,
    ) -> Result<CountResult> {
        let stop_at = Instant::now() + deadline;
        let mut out = CountResult {
            count: 0,
            exact: false,
            searched_until: None,
            cursor: cursor.map(String::from),
        };
        let mut first = true;
        loop {
            let cursor = out.cursor.clone();
            let page = retry_while_busy(stop_at, || {
                self.count_requests_page(filters, cursor.as_deref(), Some(page_timeout(stop_at)))
            })
            .await;
            let page = match page {
                Ok(page) => page,
                Err(e) if !first && (is_search_busy(&e) || is_timeout(&e)) => break,
                Err(e) => return Err(e),
            };
            first = false;
            out.count += page.count;
            out.exact = page.exact;
            out.cursor = page.cursor;
            if page.searched_until.is_some() {
                out.searched_until = page.searched_until;
            }
            if out.exact || out.cursor.is_none() || Instant::now() >= stop_at {
                break;
            }
        }
        if out.exact {
            out.cursor = None;
        }
        Ok(out)
    }

    pub async fn clear_requests(&self, slug: &str, before: Option<&str>) -> Result<()> {
        self.require_auth()?;
        let qs = match before {
            Some(b) => format!("?before={}", encode(b)),
            None => String::new(),
        };
        self.delete(&format!("/api/endpoints/{}/requests{qs}", encode(slug)))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod page_tests {
    use super::*;

    #[test]
    fn a_cursor_page_parses_as_the_typed_list() {
        let list: PaginatedRequestList = serde_json::from_str(
            r#"{"items":[{"id":"r1","endpointId":"e","method":"POST","path":"/","headers":{},"queryParams":{},"ip":"192.0.2.1","size":0,"receivedAt":1}],"cursor":"c","hasMore":true}"#,
        )
        .unwrap();
        assert_eq!(list.requests.len(), 1);
        assert_eq!(list.next_cursor.as_deref(), Some("c"));
        assert_eq!(list.has_more, Some(true));
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use axum::extract::{RawQuery, State};
    use axum::http::{HeaderMap as Headers, HeaderValue, StatusCode};
    use axum::response::IntoResponse;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// One scripted answer: a status, headers and a JSON body.
    struct Answer(u16, Vec<(&'static str, &'static str)>, Value);

    #[derive(Clone, Default)]
    struct Script {
        answers: Arc<Mutex<VecDeque<Answer>>>,
        asked: Arc<Mutex<Vec<String>>>,
    }

    async fn answer(State(script): State<Script>, RawQuery(query): RawQuery) -> impl IntoResponse {
        script.asked.lock().unwrap().push(query.unwrap_or_default());
        let Answer(status, pairs, body) = script
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .expect("one call more than the test scripted");
        let mut headers = Headers::new();
        for (name, value) in pairs {
            headers.insert(name, HeaderValue::from_static(value));
        }
        (
            StatusCode::from_u16(status).unwrap(),
            headers,
            axum::Json(body),
        )
    }

    /// A server that answers both search routes from `answers`, in order.
    async fn server(answers: Vec<Answer>) -> (ApiClient, Arc<Mutex<Vec<String>>>) {
        let script = Script {
            answers: Arc::new(Mutex::new(answers.into())),
            ..Script::default()
        };
        let asked = script.asked.clone();
        let app = axum::Router::new()
            .route("/api/search/requests", axum::routing::get(answer))
            .route("/api/search/requests/count", axum::routing::get(answer))
            .with_state(script);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), Some("whcc_test".into()), None)
                .unwrap();
        (client, asked)
    }

    fn hits(ids: &[&str]) -> Value {
        ids.iter()
            .map(|id| {
                json!({"id": id, "slug": "abc", "method": "POST", "path": "/", "headers": {},
                    "queryParams": {}, "ip": "192.0.2.1", "size": 0, "receivedAt": 1, "new": true})
            })
            .collect()
    }

    fn partial(cursor: &'static str, until: &'static str, ids: &[&str]) -> Answer {
        Answer(
            200,
            vec![
                ("x-search-complete", "false"),
                ("x-search-searched-until", until),
                ("x-search-cursor", cursor),
            ],
            hits(ids),
        )
    }

    fn done(ids: &[&str]) -> Answer {
        Answer(200, vec![("x-search-complete", "true")], hits(ids))
    }

    fn busy(retry_after: &'static str) -> Answer {
        Answer(
            429,
            vec![("retry-after", retry_after)],
            json!({"error": "search_busy", "message": "Too many searches"}),
        )
    }

    const LONG: Duration = Duration::from_secs(25);

    fn filters() -> SearchFilters<'static> {
        SearchFilters {
            slug: Some("abc"),
            query: Some("a b&c"),
            kind: Some("email"),
            from: Some("7d"),
            ..SearchFilters::default()
        }
    }

    #[tokio::test]
    async fn a_page_reads_its_progress_from_the_headers() {
        let (client, asked) =
            server(vec![partial("c1", "1700000000000", &["r1"]), done(&[])]).await;
        let page = client
            .search_requests_page(&filters(), Some(20), Some(5), Some("desc"), None, None)
            .await
            .unwrap();
        assert_eq!(page.requests.len(), 1);
        assert!(!page.complete);
        assert_eq!(page.searched_until, Some(1_700_000_000_000));
        assert_eq!(page.cursor.as_deref(), Some("c1"));
        // --json keeps fields this build does not know.
        assert_eq!(page.raw[0]["new"], true);

        let page = client
            .search_requests_page(&filters(), None, Some(5), None, Some("c1"), None)
            .await
            .unwrap();
        assert!(page.complete);
        assert_eq!((page.searched_until, page.cursor), (None, None));

        let asked = asked.lock().unwrap();
        assert_eq!(
            asked[0],
            "paged=true&slug=abc&kind=email&q=a%20b%26c&from=7d&limit=20&order=desc&offset=5"
        );
        // A cursor carries what is left of the offset.
        assert_eq!(
            asked[1],
            "paged=true&slug=abc&kind=email&q=a%20b%26c&from=7d&cursor=c1"
        );
    }

    #[tokio::test]
    async fn an_answer_without_headers_is_the_whole_search() {
        let (client, _) = server(vec![Answer(200, vec![], hits(&["r1"]))]).await;
        let found = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", None, LONG)
            .await
            .unwrap();
        assert!(found.complete);
        assert_eq!(found.requests.len(), 1);
    }

    #[tokio::test]
    async fn a_search_follows_the_cursor_until_it_has_the_limit() {
        let (client, asked) = server(vec![
            partial("c1", "300", &["r1", "r2"]),
            partial("c2", "200", &[]),
            partial("c3", "100", &["r3"]),
        ])
        .await;
        let found = client
            .search_requests(&SearchFilters::default(), 3, 7, "desc", None, LONG)
            .await
            .unwrap();
        let ids: Vec<_> = found.requests.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["r1", "r2", "r3"]);
        assert_eq!(found.raw.len(), 3);
        assert!(!found.complete);
        assert_eq!(found.searched_until, Some(100));
        assert_eq!(found.cursor.as_deref(), Some("c3"));

        // Each page asks only for what is still missing, and the offset goes
        // with the first page alone.
        let asked = asked.lock().unwrap();
        assert_eq!(
            *asked,
            [
                "paged=true&limit=3&order=desc&offset=7",
                "paged=true&limit=1&order=desc&cursor=c1",
                "paged=true&limit=1&order=desc&cursor=c2",
            ]
        );
    }

    #[tokio::test]
    async fn a_limit_past_one_page_takes_several() {
        let ids: Vec<String> = (0..200).map(|i| format!("r{i}")).collect();
        let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        let (client, asked) = server(vec![
            partial("c1", "300", &ids),
            partial("c2", "200", &ids[..50]),
        ])
        .await;
        let found = client
            .search_requests(&SearchFilters::default(), 250, 0, "desc", None, LONG)
            .await
            .unwrap();
        assert_eq!(found.requests.len(), 250);
        assert_eq!(found.cursor.as_deref(), Some("c2"));
        assert_eq!(
            *asked.lock().unwrap(),
            [
                "paged=true&limit=200&order=desc",
                "paged=true&limit=50&order=desc&cursor=c1",
            ]
        );
    }

    #[tokio::test]
    async fn a_search_stops_when_the_range_was_read() {
        let (client, asked) = server(vec![partial("c1", "300", &["r1"]), done(&["r2"])]).await;
        let found = client
            .search_requests(&SearchFilters::default(), 50, 0, "asc", None, LONG)
            .await
            .unwrap();
        assert_eq!(found.requests.len(), 2);
        assert!(found.complete);
        assert_eq!(found.cursor, None);
        assert_eq!(
            asked.lock().unwrap()[1],
            "paged=true&limit=49&order=asc&cursor=c1"
        );
    }

    #[tokio::test]
    async fn a_search_stops_at_the_deadline_and_keeps_its_cursor() {
        let (client, asked) = server(vec![partial("c1", "300", &["r1"])]).await;
        let found = client
            .search_requests(
                &SearchFilters::default(),
                50,
                0,
                "desc",
                None,
                Duration::ZERO,
            )
            .await
            .unwrap();
        assert_eq!(found.requests.len(), 1);
        assert!(!found.complete);
        assert_eq!(found.cursor.as_deref(), Some("c1"));
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_search_continues_from_a_cursor_it_was_given() {
        let (client, asked) = server(vec![done(&["r9"])]).await;
        let found = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", Some("c8"), LONG)
            .await
            .unwrap();
        assert!(found.complete);
        assert_eq!(
            asked.lock().unwrap()[0],
            "paged=true&limit=50&order=desc&cursor=c8"
        );
    }

    #[tokio::test]
    async fn a_busy_search_is_tried_again_after_retry_after() {
        let (client, asked) = server(vec![busy("1"), done(&["r1"])]).await;
        let found = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", None, LONG)
            .await
            .unwrap();
        assert_eq!(found.requests.len(), 1);
        assert_eq!(asked.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn busy_past_the_deadline_is_rate_limited_or_what_was_found() {
        // Nothing found yet: the failure, with the server's wait.
        let (client, _) = server(vec![busy("60")]).await;
        let error = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", None, LONG)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!(
            (c.code, c.exit, c.retry_after),
            ("rate_limited", 6, Some(60))
        );
        assert!(format!("{error:#}").contains("search_busy"));

        // Pages in hand: they come back, with the cursor to go on from.
        let (client, _) = server(vec![partial("c1", "300", &["r1"]), busy("60")]).await;
        let found = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", None, LONG)
            .await
            .unwrap();
        assert_eq!(found.requests.len(), 1);
        assert_eq!(found.cursor.as_deref(), Some("c1"));
        assert!(!found.complete);
    }

    #[tokio::test]
    async fn the_rate_limit_is_not_retried() {
        let (client, asked) = server(vec![Answer(
            429,
            vec![("retry-after", "1")],
            json!({"error": "Too many requests"}),
        )])
        .await;
        let error = client
            .count_requests(&SearchFilters::default(), None, LONG)
            .await
            .unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "rate_limited");
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_invalid_cursor_says_so() {
        let (client, _) = server(vec![Answer(
            400,
            vec![],
            json!({"error": "invalid_cursor"}),
        )])
        .await;
        let error = client
            .search_requests(&SearchFilters::default(), 50, 0, "desc", Some("nope"), LONG)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit, c.status), ("bad_request", 1, Some(400)));
        let message = format!("{error:#}");
        assert!(message.contains("invalid_cursor") && message.contains("--order"));
    }

    #[tokio::test]
    async fn a_count_adds_the_stretches_up() {
        let (client, asked) = server(vec![
            Answer(
                200,
                vec![],
                json!({"count": 4, "exact": false, "searchedUntil": 300, "cursor": "c1"}),
            ),
            Answer(
                200,
                vec![],
                json!({"count": 0, "exact": false, "searchedUntil": 200, "cursor": "c2"}),
            ),
            Answer(
                200,
                vec![],
                json!({"count": 3, "exact": true, "searchedUntil": null, "cursor": null}),
            ),
        ])
        .await;
        let counted = client.count_requests(&filters(), None, LONG).await.unwrap();
        assert_eq!((counted.count, counted.exact), (7, true));
        assert_eq!(counted.cursor, None);
        let asked = asked.lock().unwrap();
        assert_eq!(
            asked[0],
            "paged=true&slug=abc&kind=email&q=a%20b%26c&from=7d"
        );
        assert_eq!(
            asked[2],
            "paged=true&slug=abc&kind=email&q=a%20b%26c&from=7d&cursor=c2"
        );
    }

    #[tokio::test]
    async fn a_count_stops_at_the_deadline_as_a_lower_bound() {
        let (client, _) = server(vec![Answer(
            200,
            vec![],
            json!({"count": 4, "exact": false, "searchedUntil": 300, "cursor": "c1"}),
        )])
        .await;
        let counted = client
            .count_requests(&SearchFilters::default(), None, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!((counted.count, counted.exact), (4, false));
        assert_eq!(counted.searched_until, Some(300));
        assert_eq!(counted.cursor.as_deref(), Some("c1"));
    }

    #[test]
    fn a_count_from_before_cursors_is_exact() {
        let old: CountResult = serde_json::from_str(r#"{"count":42}"#).unwrap();
        assert!(old.exact);
        assert_eq!(
            (old.count, old.cursor, old.searched_until),
            (42, None, None)
        );
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;

    #[test]
    fn a_page_gets_what_is_left_of_the_deadline_and_a_little() {
        let now = Instant::now();
        let left = page_timeout(now + Duration::from_secs(10));
        assert!(left <= Duration::from_secs(15) && left > Duration::from_secs(14));
        // Past the deadline only the grace is left.
        assert_eq!(page_timeout(now), PAGE_GRACE);
    }

    /// A server that never answers: the page ends at its own timeout, not
    /// the client's 30 seconds.
    #[tokio::test]
    async fn a_page_past_the_deadline_times_out_early() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), Some("whcc_test".into()), None)
                .unwrap();
        let started = Instant::now();
        let error = client
            .search_requests_page(
                &SearchFilters::default(),
                None,
                None,
                None,
                None,
                Some(Duration::from_millis(200)),
            )
            .await
            .unwrap_err();
        assert!(is_timeout(&error));
        assert!(started.elapsed() < Duration::from_secs(5));
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("network_error", 7));
    }
}
