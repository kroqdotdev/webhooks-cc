use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{CapturedRequest, CountResult, PaginatedRequestList, RequestList, SearchResult};

impl ApiClient {
    pub async fn list_requests(
        &self,
        slug: &str,
        limit: Option<u32>,
        since: Option<i64>,
    ) -> Result<RequestList> {
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
            .get(&format!("/api/endpoints/{slug}/requests{qs}"))
            .await?;
        // API returns a bare array
        let requests: Vec<CapturedRequest> =
            serde_json::from_str(&resp.body).context("failed to parse request list")?;
        Ok(RequestList {
            count: Some(requests.len() as u64),
            requests,
        })
    }

    pub async fn list_requests_paginated(
        &self,
        slug: &str,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<PaginatedRequestList> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(c) = cursor {
            params.push(format!("cursor={c}"));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self
            .get(&format!("/api/endpoints/{slug}/requests/paginated{qs}"))
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse paginated request list")
    }

    pub async fn get_request(&self, request_id: &str) -> Result<CapturedRequest> {
        self.require_auth()?;
        let resp = self.get(&format!("/api/requests/{request_id}")).await?;
        serde_json::from_str(&resp.body).context("failed to parse request")
    }

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
    ) -> Result<SearchResult> {
        self.require_auth()?;
        let mut params = vec![];
        if let Some(s) = slug {
            params.push(format!("slug={s}"));
        }
        if let Some(m) = method {
            params.push(format!("method={m}"));
        }
        if let Some(q) = query {
            params.push(format!("q={}", urlencoding(q)));
        }
        if let Some(f) = from {
            params.push(format!("from={f}"));
        }
        if let Some(t) = to {
            params.push(format!("to={t}"));
        }
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        if let Some(o) = offset {
            params.push(format!("offset={o}"));
        }
        if let Some(ord) = order {
            params.push(format!("order={ord}"));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self.get(&format!("/api/search/requests{qs}")).await?;
        serde_json::from_str(&resp.body).context("failed to parse search results")
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
            params.push(format!("slug={s}"));
        }
        if let Some(m) = method {
            params.push(format!("method={m}"));
        }
        if let Some(q) = query {
            params.push(format!("q={}", urlencoding(q)));
        }
        if let Some(f) = from {
            params.push(format!("from={f}"));
        }
        if let Some(t) = to {
            params.push(format!("to={t}"));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        let resp = self
            .get(&format!("/api/search/requests/count{qs}"))
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse count result")
    }

    pub async fn clear_requests(&self, slug: &str, before: Option<&str>) -> Result<()> {
        self.require_auth()?;
        let qs = match before {
            Some(b) => format!("?before={b}"),
            None => String::new(),
        };
        self.delete(&format!("/api/endpoints/{slug}/requests{qs}"))
            .await?;
        Ok(())
    }
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '&' => "%26".to_string(),
            '=' => "%3D".to_string(),
            '#' => "%23".to_string(),
            '+' => "%2B".to_string(),
            _ => c.to_string(),
        })
        .collect()
}
