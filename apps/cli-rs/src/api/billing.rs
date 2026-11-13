use anyhow::Result;
use serde_json::Value;

use super::ApiClient;
use super::client::Fetched;

impl ApiClient {
    /// What the account pays for (`GET /api/billing`). Read loosely: the
    /// text view picks out a few fields, and `--json` prints the answer as is.
    pub async fn get_billing(&self) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.get("/api/billing").await?;
        resp.parse("billing")
    }
}
