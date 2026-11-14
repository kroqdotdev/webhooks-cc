//! An endpoint's email layouts and named email fields: the ready-made layouts
//! there are to add, adding one, and a dry run of the fields. Answers are
//! read loosely and kept as the server's JSON, so `--json` prints them as is.

use anyhow::Result;
use serde_json::{Value, json};

use super::ApiClient;
use super::client::Fetched;

fn endpoint_path(slug: &str) -> String {
    format!("/api/endpoints/{}", crate::util::url::encode(slug))
}

impl ApiClient {
    /// `GET /api/endpoints/{slug}/layouts/template`: `{ templates: [...] }`.
    pub async fn layout_templates(&self, slug: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!("{}/layouts/template", endpoint_path(slug)))
            .await?;
        resp.parse("layout templates")
    }

    /// Adds a ready-made layout to the end of the endpoint's layouts:
    /// `{ layoutId }`.
    pub async fn add_layout_template(&self, slug: &str, template: &str) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(
                &format!("{}/layouts/template", endpoint_path(slug)),
                &json!({ "template": template }),
            )
            .await?;
        resp.parse("added layout")
    }

    /// A dry run of named email fields: `{ problems, request, values }`.
    pub async fn preview_email_fields(&self, slug: &str, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(
                &format!("{}/email-fields/preview", endpoint_path(slug)),
                body,
            )
            .await?;
        resp.parse("email fields preview")
    }

    /// A dry run of layouts on a captured email:
    /// `{ problems, layoutsCap, request, parsed }`.
    pub async fn preview_layouts(&self, slug: &str, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(&format!("{}/layouts/preview", endpoint_path(slug)), body)
            .await?;
        resp.parse("layouts preview")
    }

    /// A dry run of the mock response and response rules on a captured
    /// request: `{ rule, response, unknownPlaceholders, email, request }`.
    pub async fn preview_response(&self, slug: &str, body: &Value) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .post(&format!("{}/responses/preview", endpoint_path(slug)), body)
            .await?;
        resp.parse("response preview")
    }
}
