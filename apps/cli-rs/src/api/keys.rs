use anyhow::Result;
use serde_json::Value;

use super::ApiClient;
use super::client::Fetched;
use crate::types::{ApiKeyInfo, ApprovalAnswer};

impl ApiClient {
    pub async fn list_api_keys(&self) -> Result<Fetched<Vec<ApiKeyInfo>>> {
        self.require_auth()?;
        let resp = self.get("/api/api-keys").await?;
        resp.parse("API key list")
    }

    /// Asks for a new API key. With an API key or agent token (what whk
    /// holds) the server answers 202 `{ approval }`; a browser session would
    /// get the key itself, so the raw answer is returned for the caller to
    /// tell which.
    pub async fn create_api_key(&self, name: &str, expires_in_days: Option<u32>) -> Result<Value> {
        self.require_auth()?;
        let mut body = serde_json::json!({ "name": name });
        if let Some(days) = expires_in_days {
            body["expiresInDays"] = serde_json::json!(days);
        }
        let resp = self.post("/api/api-keys", &body).await?;
        Ok(serde_json::from_str(&resp.body)?)
    }

    pub async fn revoke_api_key(&self, id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!("/api/api-keys?id={}", urlencoding::encode(id)))
            .await?;
        Ok(())
    }

    pub async fn get_approval(&self, id: &str) -> Result<Fetched<ApprovalAnswer>> {
        self.require_auth()?;
        let resp = self
            .get(&format!("/api/approvals/{}", urlencoding::encode(id)))
            .await?;
        resp.parse("approval")
    }
}
