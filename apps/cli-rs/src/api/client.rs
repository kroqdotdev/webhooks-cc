use anyhow::{Context, Result};
use reqwest::{Method, Response, StatusCode};

use super::{ApiClient, extract_error};

/// HTTP response with body pre-read.
pub struct ApiResponse {
    pub body: String,
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

    /// Perform a DELETE request.
    pub async fn delete(&self, path: &str) -> Result<ApiResponse> {
        self.send(Method::DELETE, path, None).await
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

    async fn send_once(
        &self,
        method: &Method,
        path: &str,
        body: &Option<Vec<u8>>,
        refresh: bool,
    ) -> Result<Response> {
        let headers = self.headers_with(refresh).await?;
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
    let body = resp.text().await.context("failed to read response body")?;

    if status.is_client_error() || status.is_server_error() {
        anyhow::bail!("{}", extract_error(status, &body));
    }

    Ok(ApiResponse { body })
}
