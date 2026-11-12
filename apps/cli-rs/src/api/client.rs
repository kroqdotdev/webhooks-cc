use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, RETRY_AFTER};
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{ApiClient, api_error_message};
use crate::error::ApiError;

/// HTTP response with body pre-read.
pub struct ApiResponse {
    pub body: String,
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

    /// Perform a POST request with a JSON body.
    pub async fn post(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let body = serde_json::to_vec(body).context("failed to encode request body")?;
        self.send(Method::POST, path, Some(body)).await
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
    /// they can replace `Content-Type`; `Authorization` and `User-Agent`
    /// always stay the CLI's own.
    pub async fn send_raw(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        extra: &[(String, String)],
    ) -> Result<RawResponse> {
        let mut extra_headers = HeaderMap::new();
        for (name, value) in extra {
            let name = HeaderName::from_bytes(name.trim().as_bytes())
                .with_context(|| format!("invalid header name: {name}"))?;
            if name == reqwest::header::AUTHORIZATION || name == reqwest::header::USER_AGENT {
                anyhow::bail!("whk sets the {name} header itself");
            }
            let value = HeaderValue::from_str(value.trim())
                .with_context(|| format!("invalid value for header {name}"))?;
            extra_headers.insert(name, value);
        }
        let mut resp = self
            .send_once_with(&method, path, &body, false, &extra_headers)
            .await?;
        if resp.status() == StatusCode::UNAUTHORIZED && self.can_refresh() {
            resp = self
                .send_once_with(&method, path, &body, true, &extra_headers)
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
        self.send_once_with(method, path, body, refresh, &HeaderMap::new())
            .await
    }

    async fn send_once_with(
        &self,
        method: &Method,
        path: &str,
        body: &Option<Vec<u8>>,
        refresh: bool,
        extra: &HeaderMap,
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
        request.send().await.context("request failed")
    }
}

async fn read_response(resp: Response) -> Result<ApiResponse> {
    let status = resp.status();
    let retry_after = retry_after(resp.headers());
    let body = resp.text().await.context("failed to read response body")?;

    if status.is_client_error() || status.is_server_error() {
        return Err(api_error(status, &body, retry_after).into());
    }

    Ok(ApiResponse { body })
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
