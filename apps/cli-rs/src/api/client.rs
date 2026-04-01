use anyhow::{Context, Result};
use reqwest::Response;

use super::{extract_error, ApiClient};

/// HTTP response with body pre-read.
pub struct ApiResponse {
    pub body: String,
}

impl ApiClient {
    /// Perform a GET request and return the response body.
    pub async fn get(&self, path: &str) -> Result<ApiResponse> {
        let headers = self.auth_headers()?;
        let resp = self
            .http
            .get(self.url(path))
            .headers(headers)
            .send()
            .await
            .context("request failed")?;
        read_response(resp).await
    }

    /// Perform a POST request with a JSON body.
    pub async fn post(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let headers = self.auth_headers()?;
        let resp = self
            .http
            .post(self.url(path))
            .headers(headers)
            .json(body)
            .send()
            .await
            .context("request failed")?;
        read_response(resp).await
    }

    /// Perform a PATCH request with a JSON body.
    pub async fn patch(&self, path: &str, body: &impl serde::Serialize) -> Result<ApiResponse> {
        let headers = self.auth_headers()?;
        let resp = self
            .http
            .patch(self.url(path))
            .headers(headers)
            .json(body)
            .send()
            .await
            .context("request failed")?;
        read_response(resp).await
    }

    /// Perform a DELETE request.
    pub async fn delete(&self, path: &str) -> Result<ApiResponse> {
        let headers = self.auth_headers()?;
        let resp = self
            .http
            .delete(self.url(path))
            .headers(headers)
            .send()
            .await
            .context("request failed")?;
        read_response(resp).await
    }
}

async fn read_response(resp: Response) -> Result<ApiResponse> {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .unwrap_or_default();

    if status.is_client_error() || status.is_server_error() {
        anyhow::bail!("{}", extract_error(status, &body));
    }

    Ok(ApiResponse { body })
}
