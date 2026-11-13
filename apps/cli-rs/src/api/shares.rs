//! The web app's routes for shares and reserved names.

use anyhow::{Context, Result};

use super::ApiClient;
use crate::types::{
    NamePassword, NamesResponse, ReservedName, ShareRequestsResponse, SharesResponse,
};

impl ApiClient {
    /// `GET /api/shares?state=live|ended`.
    pub async fn list_shares(&self, ended: bool) -> Result<SharesResponse> {
        self.require_auth()?;
        let state = if ended { "ended" } else { "live" };
        let resp = self.get(&format!("/api/shares?state={state}")).await?;
        serde_json::from_str(&resp.body).context("failed to parse share list")
    }

    /// `POST /api/shares/{id}/stop`.
    pub async fn stop_share(&self, id: &str) -> Result<()> {
        self.require_auth()?;
        self.post(
            &format!("/api/shares/{}/stop", crate::util::url::encode(id)),
            &serde_json::json!({}),
        )
        .await?;
        Ok(())
    }

    /// `GET /api/shares/{id}/requests`: what the share answered lately.
    pub async fn share_requests(&self, id: &str) -> Result<ShareRequestsResponse> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "/api/shares/{}/requests",
                crate::util::url::encode(id)
            ))
            .await?;
        serde_json::from_str(&resp.body).context("failed to parse share requests")
    }

    /// `GET /api/tunnel-names`.
    pub async fn list_names(&self) -> Result<NamesResponse> {
        self.require_auth()?;
        let resp = self.get("/api/tunnel-names").await?;
        serde_json::from_str(&resp.body).context("failed to parse name list")
    }

    /// `POST /api/tunnel-names` with `{name}`, and `{team}` (a team id) to
    /// keep it inside that team.
    pub async fn reserve_name(&self, name: &str, team: Option<&str>) -> Result<ReservedName> {
        self.require_auth()?;
        let body = match team {
            Some(team) => serde_json::json!({ "name": name, "team": team }),
            None => serde_json::json!({ "name": name }),
        };
        let resp = self.post("/api/tunnel-names", &body).await?;
        serde_json::from_str(&resp.body).context("failed to parse reserved name")
    }

    /// `DELETE /api/tunnel-names/{name}`.
    pub async fn release_name(&self, name: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/tunnel-names/{}",
            crate::util::url::encode(name)
        ))
        .await?;
        Ok(())
    }

    /// `PUT /api/tunnel-names/{name}/password` with `{password}`, or
    /// `DELETE` on the same path to take it off (`None`).
    pub async fn set_name_password(
        &self,
        name: &str,
        password: Option<&str>,
    ) -> Result<NamePassword> {
        self.require_auth()?;
        let path = format!(
            "/api/tunnel-names/{}/password",
            crate::util::url::encode(name)
        );
        let resp = match password {
            Some(password) => {
                self.put_json(&path, &serde_json::json!({ "password": password }))
                    .await?
            }
            None => self.delete(&path).await?,
        };
        serde_json::from_str(&resp.body).context("failed to parse the password answer")
    }
}
