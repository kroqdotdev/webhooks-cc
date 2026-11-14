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

    /// A checkout link for the person to pay (`POST /api/billing/checkouts`).
    pub async fn create_checkout(&self, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.post("/api/billing/checkouts", body).await?;
        resp.parse("checkout link")
    }

    /// Where a checkout link stands (`GET /api/billing/checkouts/{id}`).
    pub async fn get_checkout(&self, id: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "/api/billing/checkouts/{}",
                crate::util::url::encode(id)
            ))
            .await?;
        resp.parse("checkout link")
    }
}
