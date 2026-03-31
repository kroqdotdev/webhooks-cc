use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::UsageInfo;

impl ApiClient {
    pub async fn get_usage(&self) -> Result<UsageInfo> {
        self.require_auth()?;
        let resp = self.get("/api/usage").await?;
        serde_json::from_str(&resp.body).context("failed to parse usage info")
    }
}
