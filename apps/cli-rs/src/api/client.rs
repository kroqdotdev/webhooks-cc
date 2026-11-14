use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

use super::{ApiClient, api_error_message};
use crate::error::ApiError;

/// HTTP response with body pre-read.
pub struct ApiResponse {
    pub body: String,
    /// The server's clock from the `Date` header, in ms (whole seconds).
    pub server_time_ms: Option<i64>,
    /// The answer's headers (search reports its progress in `X-Search-*`).
    pub headers: HeaderMap,
}

impl ApiResponse {
    /// The body as `T`, keeping the server's JSON beside it so `--json`
    /// prints exactly what the API answered, fields this build does not know
    /// included.
    pub fn parse<T: DeserializeOwned>(&self, what: &str) -> Result<Fetched<T>> {
        let raw: Value =
            serde_json::from_str(&self.body).with_context(|| format!("failed to parse {what}"))?;
        let value = serde_json::from_value(raw.clone())
            .with_context(|| format!("failed to parse {what}"))?;
        Ok(Fetched { value, raw })
    }
}

/// A parsed answer and the JSON it came from. Derefs to the parsed value.
#[derive(Debug, Clone)]
pub struct Fetched<T> {
    pub value: T,
    pub raw: Value,
}

impl<T: serde::Serialize> Fetched<T> {
    /// What `--json` prints: the server's JSON, plus any key the CLI's own
    /// type always printed that the server left out (an `id` the stream
    /// sends as `_id`, a field it omits instead of sending null), so output
    /// only ever gains fields.
    pub fn json(&self) -> Value {
        let mut out = self.raw.clone();
        if let Ok(typed) = serde_json::to_value(&self.value) {
            fill_missing(&mut out, &typed);
        }
        out
    }
}

/// Adds to `out` every key `extra` has and `out` lacks, in nested objects
/// and in arrays of the same length too. Values `out` has are kept.
pub fn fill_missing(out: &mut Value, extra: &Value) {
    match (out, extra) {
        (Value::Object(out), Value::Object(extra)) => {
            for (key, value) in extra {
                match out.get_mut(key) {
                    Some(existing) => fill_missing(existing, value),
                    None => {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(out), Value::Array(extra)) if out.len() == extra.len() => {
            for (o, e) in out.iter_mut().zip(extra) {
                fill_missing(o, e);
            }
        }
        _ => {}
    }
}

impl<T> std::ops::Deref for Fetched<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

impl<T> std::ops::DerefMut for Fetched<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.value
    }
}

/// A raw answer for `whk api`: the status and body whatever they are.
pub struct RawResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl ApiClient {
    /// Perform a GET request and return the response body.
    pub async fn get(&self, path: &str) -> Result<ApiResponse> {
        self.send(Method::GET, path, None).await
    }

    /// A GET that gives up after `timeout` when that is shorter than the
    /// client's own request timeout.
    pub async fn get_within(&self, path: &str, timeout: Option<Duration>) -> Result<ApiResponse> {
        let timeout = timeout.map(|t| t.min(super::REQUEST_TIMEOUT));
        let mut resp = self
            .send_once_with(&Method::GET, path, &None, false, &HeaderMap::new(), timeout)
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED && self.can_refresh() {
            resp = self
                .send_once_with(&Method::GET, path, &None, true, &HeaderMap::new(), timeout)
                .await?;
        }
        read_response(resp).await
    }

    /// Perform a POST request with a JSON body.
    pub async fn post(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let body = serde_json::to_vec(body).context("failed to encode request body")?;
        self.send(Method::POST, path, Some(body)).await
    }

    /// A POST with a JSON body that may take `timeout` rather than the
    /// client's own request timeout: for a route that does slow work while
    /// the caller waits, such as a destination's test delivery.
    pub async fn post_within(
        &self,
        path: &str,
        body: &impl serde::Serialize,
        timeout: Duration,
    ) -> Result<ApiResponse> {
        let body = Some(serde_json::to_vec(body).context("failed to encode request body")?);
        let none = HeaderMap::new();
        let mut resp = self
            .send_once_with(&Method::POST, path, &body, false, &none, Some(timeout))
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED && self.can_refresh() {
            resp = self
                .send_once_with(&Method::POST, path, &body, true, &none, Some(timeout))
                .await?;
        }
        read_response(resp).await
    }

    /// Perform a PATCH request with a JSON body.
    pub async fn patch(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let body = serde_json::to_vec(body).context("failed to encode request body")?;
        self.send(Method::PATCH, path, Some(body)).await
    }

    /// Perform a PUT request without a body.
    pub async fn put(&self, path: &str) -> Result<ApiResponse> {
        self.send(Method::PUT, path, None).await
    }

    /// Perform a PUT request with a JSON body.
    pub async fn put_json(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let body = serde_json::to_vec(body).context("failed to encode request body")?;
        self.send(Method::PUT, path, Some(body)).await
    }

    /// Perform a DELETE request.
    pub async fn delete(&self, path: &str) -> Result<ApiResponse> {
        self.send(Method::DELETE, path, None).await
    }

    /// Perform a GET request without credentials, for a route that takes none.
    pub async fn get_anonymous(&self, path: &str) -> Result<ApiResponse> {
        self.send_anonymous(Method::GET, path, None).await
    }

    /// Perform a POST request with a JSON body and without credentials.
    pub async fn post_anonymous(
        &self,
        path: &str,
        body: &impl serde::Serialize,
    ) -> Result<ApiResponse> {
        let body = serde_json::to_vec(body).context("failed to encode request body")?;
        self.send_anonymous(Method::POST, path, Some(body)).await
    }

    async fn send_anonymous(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<ApiResponse> {
        let mut request = self
            .http
            .request(method, self.url(path))
            .headers(Self::anonymous_headers()?);
        if let Some(body) = body {
            request = request.body(body);
        }
        read_response(request.send().await.context("request failed")?).await
    }

    /// Sends a request. With an agent connection, a 401 (the cached token
    /// was revoked or ran out) is retried once with a newly exchanged token.
    async fn send(&self, method: Method, path: &str, body: Option<Vec<u8>>) -> Result<ApiResponse> {
        let mut resp = self.send_once(&method, path, &body, false).await?;
        if resp.status() == StatusCode::UNAUTHORIZED && self.can_refresh() {
            resp = self.send_once(&method, path, &body, true).await?;
        }
        read_response(resp).await
    }

    /// Sends any request to an API path and returns the answer whatever its
    /// status (`whk api`). `extra` headers are added after the defaults, so
    /// they can replace `Content-Type`; the caller keeps `Authorization` and
    /// `User-Agent` out of them.
    pub async fn send_raw(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        extra_headers: &HeaderMap,
    ) -> Result<RawResponse> {
        let mut resp = self
            .send_once_with(&method, path, &body, false, extra_headers, None)
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED && self.can_refresh() {
            resp = self
                .send_once_with(&method, path, &body, true, extra_headers, None)
                .await?;
        }
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp
            .bytes()
            .await
            .context("failed to read response body")?
            .to_vec();
        Ok(RawResponse {
            status,
            headers,
            body,
        })
    }

    async fn send_once(
        &self,
        method: &Method,
        path: &str,
        body: &Option<Vec<u8>>,
        refresh: bool,
    ) -> Result<Response> {
        self.send_once_with(method, path, body, refresh, &HeaderMap::new(), None)
            .await
    }

    async fn send_once_with(
        &self,
        method: &Method,
        path: &str,
        body: &Option<Vec<u8>>,
        refresh: bool,
        extra: &HeaderMap,
        timeout: Option<Duration>,
    ) -> Result<Response> {
        let mut headers = self.headers_with(refresh).await?;
        for (name, value) in extra {
            headers.insert(name.clone(), value.clone());
        }
        let mut request = self
            .http
            .request(method.clone(), self.url(path))
            .headers(headers);
        if let Some(body) = body {
            request = request.body(body.clone());
        }
        // A request's own timeout replaces the client's, longer or shorter.
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        request.send().await.context("request failed")
    }
}

async fn read_response(resp: Response) -> Result<ApiResponse> {
    let status = resp.status();
    let retry_after = retry_after(resp.headers());
    let server_time_ms = resp
        .headers()
        .get(reqwest::header::DATE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| chrono::DateTime::parse_from_rfc2822(v).ok())
        .map(|t| t.timestamp() * 1000);
    let headers = resp.headers().clone();
    let body = resp.text().await.context("failed to read response body")?;

    if status.is_client_error() || status.is_server_error() {
        return Err(api_error(status, &body, retry_after).into());
    }

    Ok(ApiResponse {
        body,
        server_time_ms,
        headers,
    })
}

/// The error for an answer with a failing status.
pub fn api_error(status: StatusCode, body: &str, retry_after: Option<u64>) -> ApiError {
    ApiError {
        status: status.as_u16(),
        message: api_error_message(status, body),
        retry_after,
    }
}

/// Seconds from a `Retry-After` header given in seconds.
pub fn retry_after(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn printed_json_keeps_server_fields_and_the_old_ones() {
        let mut out =
            json!({"_id": "r1", "method": "POST", "nested": {"a": 1}, "list": [{"x": 1}]});
        let typed = json!({"id": "r1", "method": "POST", "signatureVerified": null,
            "nested": {"a": 1, "b": null}, "list": [{"x": 1, "y": null}]});
        fill_missing(&mut out, &typed);
        assert_eq!(
            out,
            json!({"_id": "r1", "id": "r1", "method": "POST", "signatureVerified": null,
                "nested": {"a": 1, "b": null}, "list": [{"x": 1, "y": null}]})
        );
    }
}
