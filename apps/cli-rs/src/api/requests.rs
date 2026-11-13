use anyhow::{Context, Result};
use urlencoding::encode;

use super::ApiClient;
use super::client::Fetched;
use crate::types::{
    CapturedRequest, CountResult, EmailFormat, PaginatedRequestList, RenderedEmail, RequestList,
    SearchResult,
};

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

    /// One page of an endpoint's requests, newest first, as the server sent
    /// them (`GET .../requests/paginated`), with the cursor for the next,
    /// older page and the server's clock.
    pub async fn requests_page_raw(
        &self,
        slug: &str,
        limit: u32,
        cursor: Option<&str>,
        kind: Option<&str>,
    ) -> Result<RawPage> {
        self.require_auth()?;
        let mut params = vec![format!("limit={limit}")];
        if let Some(c) = cursor {
            params.push(format!("cursor={}", encode(c)));
        }
        if let Some(k) = kind {
            params.push(format!("kind={}", encode(k)));
        }
        let resp = self
            .get(&format!(
                "/api/endpoints/{}/requests/paginated?{}",
                encode(slug),
                params.join("&")
            ))
            .await?;
        let mut page = parse_page(&resp.body)?;
        page.server_time_ms = resp.server_time_ms;
        Ok(page)
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

    #[allow(clippy::too_many_arguments)]
    pub async fn search_requests(
        &self,
        slug: Option<&str>,
        method: Option<&str>,
        query: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
        order: Option<&str>,
    ) -> Result<Fetched<SearchResult>> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(s) = slug {
            params.push(format!("slug={}", encode(s)));
        }
        if let Some(m) = method {
            params.push(format!("method={}", encode(m)));
        }
        if let Some(q) = query {
            params.push(format!("q={}", encode(q)));
        }
        if let Some(f) = from {
            params.push(format!("from={}", encode(f)));
        }
        if let Some(t) = to {
            params.push(format!("to={}", encode(t)));
        }
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(o) = offset {
            params.push(format!("offset={o}"));
        }
        if let Some(ord) = order {
            params.push(format!("order={}", encode(ord)));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self.get(&format!("/api/search/requests{qs}")).await?;
        resp.parse("search results")
    }

    pub async fn count_requests(
        &self,
        slug: Option<&str>,
        method: Option<&str>,
        query: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<CountResult> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(s) = slug {
            params.push(format!("slug={}", encode(s)));
        }
        if let Some(m) = method {
            params.push(format!("method={}", encode(m)));
        }
        if let Some(q) = query {
            params.push(format!("q={}", encode(q)));
        }
        if let Some(f) = from {
            params.push(format!("from={}", encode(f)));
        }
        if let Some(t) = to {
            params.push(format!("to={}", encode(t)));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self.get(&format!("/api/search/requests/count{qs}")).await?;
        serde_json::from_str(&resp.body).context("failed to parse count result")
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

/// A page of requests as the paginated route sent it.
#[derive(Debug, Default)]
pub struct RawPage {
    pub items: Vec<serde_json::Value>,
    /// The cursor for the next (older) page; none on the last page.
    pub next: Option<String>,
    pub server_time_ms: Option<i64>,
}

/// Reads the paginated route's `{ items, cursor, hasMore }`.
pub fn parse_page(body: &str) -> Result<RawPage> {
    let mut page: serde_json::Value =
        serde_json::from_str(body).context("failed to parse request page")?;
    let items = match page.get_mut("items").map(serde_json::Value::take) {
        Some(serde_json::Value::Array(items)) => items,
        _ => anyhow::bail!("failed to parse request page: no items"),
    };
    let more = page
        .get("hasMore")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let next = page
        .get("cursor")
        .and_then(serde_json::Value::as_str)
        .filter(|_| more)
        .map(String::from);
    Ok(RawPage {
        items,
        next,
        server_time_ms: None,
    })
}

#[cfg(test)]
mod page_tests {
    use super::*;

    #[test]
    fn pages_are_read_as_the_route_sends_them() {
        let page = parse_page(r#"{"items":[{"id":"a"},{"id":"b"}],"cursor":"c1","hasMore":true}"#)
            .unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.next.as_deref(), Some("c1"));
        let last = parse_page(r#"{"items":[{"id":"a"}],"cursor":"c2","hasMore":false}"#).unwrap();
        assert_eq!(last.next, None);
        let empty = parse_page(r#"{"items":[],"hasMore":false}"#).unwrap();
        assert!(empty.items.is_empty() && empty.next.is_none());
        assert!(parse_page(r#"{"requests":[]}"#).is_err());
    }

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
