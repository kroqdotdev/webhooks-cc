use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{SendResponse, SendWebhookRequest};

impl ApiClient {
    /// Send a test webhook to a hosted endpoint.
    pub async fn send_webhook(&self, req: &SendWebhookRequest) -> Result<SendResponse> {
        self.require_auth()?;
        let resp = self.post("/api/send-test", req).await?;
        serde_json::from_str(&resp.body).context("failed to parse send response")
    }

    /// Send a webhook directly to an arbitrary URL.
    pub async fn send_to(
        &self,
        url: &str,
        method: &str,
        headers: &std::collections::HashMap<String, String>,
        body: Option<&str>,
    ) -> Result<SendResponse> {
        let mut req_builder = self.http.request(
            method.parse().unwrap_or(reqwest::Method::POST),
            url,
        );

        for (k, v) in headers {
            req_builder = req_builder.header(k.as_str(), v.as_str());
        }

        if let Some(b) = body {
            req_builder = req_builder.body(b.to_string());
        }

        let resp = req_builder.send().await.context("request failed")?;
        let status = resp.status().as_u16();
        let status_text = resp.status().to_string();
        let body = resp.text().await.unwrap_or_default();

        Ok(SendResponse {
            status,
            status_text,
            body: Some(body),
        })
    }
}
