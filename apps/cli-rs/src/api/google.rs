//! Google accounts for Sheets destinations, and AI setup. Connecting an
//! account, choosing a spreadsheet from Drive and AI setup answer an API key
//! with 202 `{ approval }`; the raw answer is returned so the caller can tell
//! an approval from a result.

use anyhow::Result;
use serde_json::{Value, json};

use super::ApiClient;

fn body(resp: super::client::ApiResponse) -> Result<Value> {
    if resp.body.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&resp.body)?)
}

impl ApiClient {
    pub async fn google_connections(&self) -> Result<Value> {
        self.require_auth()?;
        body(self.get("/api/integrations/google/connections").await?)
    }

    pub async fn google_connect(&self) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post("/api/integrations/google/start", &json!({}))
                .await?,
        )
    }

    pub async fn google_pick(&self, connection_id: &str) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post(
                "/api/integrations/google/pick",
                &json!({ "connectionId": connection_id }),
            )
            .await?,
        )
    }

    pub async fn google_tabs(&self, connection_id: &str, spreadsheet_id: &str) -> Result<Value> {
        self.require_auth()?;
        body(
            self.get(&format!(
                "/api/integrations/google/spreadsheets?connectionId={}&spreadsheetId={}",
                crate::util::url::encode(connection_id),
                crate::util::url::encode(spreadsheet_id)
            ))
            .await?,
        )
    }

    pub async fn google_create_spreadsheet(&self, input: &Value) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post("/api/integrations/google/spreadsheets", input)
                .await?,
        )
    }

    pub async fn google_disconnect(&self, connection_id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/integrations/google/connections/{}",
            crate::util::url::encode(connection_id)
        ))
        .await?;
        Ok(())
    }

    pub async fn ai_status(&self, slug: &str) -> Result<Value> {
        self.require_auth()?;
        body(
            self.get(&format!(
                "/api/endpoints/{}/layouts/assist",
                crate::util::url::encode(slug)
            ))
            .await?,
        )
    }

    pub async fn ai_setup(&self, slug: &str, input: &Value) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post(
                &format!(
                    "/api/endpoints/{}/layouts/assist",
                    crate::util::url::encode(slug)
                ),
                input,
            )
            .await?,
        )
    }
}
