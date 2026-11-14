use anyhow::Result;
use serde_json::{Value, json};

use super::ApiClient;
use super::client::Fetched;
use crate::types::{Team, TeamInvite, TeamMembersResponse};

fn team_path(team_id: &str) -> String {
    format!("/api/teams/{}", crate::util::url::encode(team_id))
}

impl ApiClient {
    pub async fn list_teams(&self) -> Result<Fetched<Vec<Team>>> {
        self.require_auth()?;
        let resp = self.get("/api/teams").await?;
        resp.parse("team list")
    }

    pub async fn list_team_members(&self, team_id: &str) -> Result<Fetched<TeamMembersResponse>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "/api/teams/{}/members",
                crate::util::url::encode(team_id)
            ))
            .await?;
        resp.parse("team members")
    }

    /// Share an endpoint the caller owns with a team. Takes the endpoint id;
    /// callers resolve a slug with `get_endpoint` first.
    pub async fn share_endpoint(&self, team_id: &str, endpoint_id: &str) -> Result<()> {
        self.require_auth()?;
        let body = serde_json::json!({ "endpointId": endpoint_id });
        self.post(
            &format!("/api/teams/{}/endpoints", crate::util::url::encode(team_id)),
            &body,
        )
        .await?;
        Ok(())
    }

    pub async fn unshare_endpoint(&self, team_id: &str, endpoint_id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/teams/{}/endpoints/{}",
            crate::util::url::encode(team_id),
            crate::util::url::encode(endpoint_id)
        ))
        .await?;
        Ok(())
    }

    pub async fn invite_team_member(
        &self,
        team_id: &str,
        email: &str,
    ) -> Result<Fetched<TeamInvite>> {
        self.require_auth()?;
        let body = serde_json::json!({ "email": email });
        let resp = self
            .post(
                &format!("/api/teams/{}/invite", crate::util::url::encode(team_id)),
                &body,
            )
            .await?;
        resp.parse("invite")
    }

    pub async fn list_invites(&self) -> Result<Fetched<Vec<TeamInvite>>> {
        self.require_auth()?;
        let resp = self.get("/api/invites").await?;
        resp.parse("invite list")
    }

    pub async fn accept_invite(&self, invite_id: &str) -> Result<()> {
        self.require_auth()?;
        let body = serde_json::json!({});
        self.post(
            &format!(
                "/api/invites/{}/accept",
                crate::util::url::encode(invite_id)
            ),
            &body,
        )
        .await?;
        Ok(())
    }

    pub async fn decline_invite(&self, invite_id: &str) -> Result<()> {
        self.require_auth()?;
        let body = serde_json::json!({});
        self.post(
            &format!(
                "/api/invites/{}/decline",
                crate::util::url::encode(invite_id)
            ),
            &body,
        )
        .await?;
        Ok(())
    }

    /// Create a team the caller owns. The answer is the new team.
    pub async fn create_team(&self, name: &str) -> Result<Fetched<Team>> {
        self.require_auth()?;
        let resp = self.post("/api/teams", &json!({ "name": name })).await?;
        resp.parse("team")
    }

    pub async fn rename_team(&self, team_id: &str, name: &str) -> Result<()> {
        self.require_auth()?;
        self.patch(&team_path(team_id), &json!({ "name": name }))
            .await?;
        Ok(())
    }

    /// Delete a team the caller owns. An API key gets 202 `{ approval }` (the
    /// owner approves first); a session gets 204, read as `null`. The raw
    /// answer is returned so the caller can tell the two apart.
    pub async fn delete_team(&self, team_id: &str) -> Result<Value> {
        self.require_auth()?;
        let resp = self.delete(&team_path(team_id)).await?;
        if resp.body.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&resp.body)?)
    }

    pub async fn remove_team_member(&self, team_id: &str, user_id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "{}/members/{}",
            team_path(team_id),
            crate::util::url::encode(user_id)
        ))
        .await?;
        Ok(())
    }

    pub async fn leave_team(&self, team_id: &str) -> Result<()> {
        self.require_auth()?;
        self.post(&format!("{}/leave", team_path(team_id)), &json!({}))
            .await?;
        Ok(())
    }

    pub async fn withdraw_invite(&self, team_id: &str, invite_id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "{}/invites/{}",
            team_path(team_id),
            crate::util::url::encode(invite_id)
        ))
        .await?;
        Ok(())
    }

    /// What changing a team's seat count would cost (owner only). Read
    /// loosely: `--json` prints the answer as is.
    pub async fn quote_team_seats(&self, team_id: &str, seats: u32) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "{}/billing/seats?seats={seats}",
                team_path(team_id)
            ))
            .await?;
        resp.parse("seat quote")
    }

    /// What moving a team to another plan would cost (owner only).
    pub async fn quote_team_plan(
        &self,
        team_id: &str,
        plan: &str,
        interval: &str,
    ) -> Result<Fetched<Value>> {
        self.require_auth()?;
        let resp = self
            .get(&format!(
                "{}/billing/plan?plan={}&interval={}",
                team_path(team_id),
                crate::util::url::encode(plan),
                crate::util::url::encode(interval)
            ))
            .await?;
        resp.parse("plan quote")
    }
}
