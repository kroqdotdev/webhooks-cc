//! An endpoint's alerts: the settings (when an alert opens and who hears of
//! it) and the recent alerts. Answers are read loosely and kept as the
//! server's JSON, so `--json` prints them as is.

use anyhow::Result;
use serde_json::Value;

use super::ApiClient;
use super::client::Fetched;

fn alerts_path(slug: &str) -> String {
    format!("/api/endpoints/{}/alerts", crate::util::url::encode(slug))
}

impl ApiClient {
    /// `GET /api/endpoints/{slug}/alerts`: `{ settings, events }`.
    pub async fn get_alerts(&self, slug: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.get(&alerts_path(slug)).await?;
        resp.parse("alerts")
    }

    /// `PUT /api/endpoints/{slug}/alerts` with the settings to change (the
    /// rest stay as saved): `{ settings }`.
    pub async fn update_alerts(&self, slug: &str, settings: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self.put_json(&alerts_path(slug), settings).await?;
        resp.parse("alert settings")
    }
}
