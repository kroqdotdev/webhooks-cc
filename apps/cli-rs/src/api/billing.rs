use anyhow::Result;
use serde_json::Value;

use super::ApiClient;
use super::client::Fetched;

/// Where a billing change goes: the account's own billing, or a team's.
fn billing_path(team_id: Option<&str>, route: &str) -> String {
    match team_id {
        Some(id) => format!(
            "/api/teams/{}/billing/{route}",
            crate::util::url::encode(id)
        ),
        None => format!("/api/billing/{route}"),
    }
}

fn raw(resp: super::client::ApiResponse) -> Result<Value> {
    if resp.body.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&resp.body)?)
}

impl ApiClient {
    /// What the account pays for (`GET /api/billing`). Read loosely: the
    /// text view picks out a few fields, and `--json` prints the answer as is.
    pub async fn get_billing(&self) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.get("/api/billing").await?;
        resp.parse("billing")
    }

    /// A billing change (a plan, seats, add-ons, cancelling or keeping the
    /// plan). With an API key the route answers 202 with a quoted approval
    /// for the account's owner; a browser session's answer is the change
    /// itself (null for 204).
    pub async fn billing_change(
        &self,
        team_id: Option<&str>,
        route: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        self.require_auth()?;
        let path = billing_path(team_id, route);
        let resp = match body {
            Some(body) => self.post(&path, body).await?,
            None => self.delete(&path).await?,
        };
        raw(resp)
    }
}
