//! Account routes that work with an API key: connected agents, share links
//! to requests, custom inbound domains and the display name. The ones a
//! person must allow (a new share link, removing a domain, a rename) answer
//! an API key with 202 `{ approval }`; the raw answer is returned so the
//! caller can tell an approval from a result.

use anyhow::Result;
use serde_json::{Value, json};

use super::ApiClient;

fn body(resp: super::client::ApiResponse) -> Result<Value> {
    if resp.body.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&resp.body)?)
}

fn team_query(team: Option<&str>) -> String {
    team.map(|t| format!("?team={}", crate::util::url::encode(t)))
        .unwrap_or_default()
}

impl ApiClient {
    pub async fn rename_account(&self, name: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        body(self.patch("/api/account", &json!({ "name": name })).await?)
    }

    pub async fn list_agents(&self) -> Result<Value> {
        self.require_auth()?;
        body(self.get("/api/agent/registrations").await?)
    }

    pub async fn disconnect_agent(&self, id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/agent/registrations/{}",
            crate::util::url::encode(id)
        ))
        .await?;
        Ok(())
    }

    /// The account's live share links, or one request's.
    pub async fn list_share_links(&self, request_id: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        let path = match request_id {
            Some(id) => format!("/api/requests/{}/shares", crate::util::url::encode(id)),
            None => "/api/request-shares".to_string(),
        };
        body(self.get(&path).await?)
    }

    pub async fn create_share_link(
        &self,
        request_id: &str,
        expires_in_days: u32,
        hide_sensitive: bool,
    ) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post(
                &format!(
                    "/api/requests/{}/shares",
                    crate::util::url::encode(request_id)
                ),
                &json!({ "expiresInDays": expires_in_days, "hideSensitive": hide_sensitive }),
            )
            .await?,
        )
    }

    pub async fn revoke_share_link(&self, id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/request-shares/{}",
            crate::util::url::encode(id)
        ))
        .await?;
        Ok(())
    }

    pub async fn list_domains(&self, team: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        body(
            self.get(&format!("/api/domains{}", team_query(team)))
                .await?,
        )
    }

    pub async fn add_domain(&self, domain: &str, team: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post(
                &format!("/api/domains{}", team_query(team)),
                &json!({ "domain": domain }),
            )
            .await?,
        )
    }

    pub async fn verify_domain(&self, id: &str, team: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        body(
            self.post(
                &format!(
                    "/api/domains/{}/verify{}",
                    crate::util::url::encode(id),
                    team_query(team)
                ),
                &json!({}),
            )
            .await?,
        )
    }

    pub async fn route_domain(
        &self,
        id: &str,
        team: Option<&str>,
        routing: &Value,
    ) -> Result<Value> {
        self.require_auth()?;
        body(
            self.patch(
                &format!(
                    "/api/domains/{}{}",
                    crate::util::url::encode(id),
                    team_query(team)
                ),
                routing,
            )
            .await?,
        )
    }

    pub async fn remove_domain(&self, id: &str, team: Option<&str>) -> Result<Value> {
        self.require_auth()?;
        body(
            self.delete(&format!(
                "/api/domains/{}{}",
                crate::util::url::encode(id),
                team_query(team)
            ))
            .await?,
        )
    }
}
