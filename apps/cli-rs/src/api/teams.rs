use anyhow::Result;

use super::ApiClient;
use super::client::Fetched;
use crate::types::{Team, TeamInvite, TeamMembersResponse};

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
                urlencoding::encode(team_id)
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
            &format!("/api/teams/{}/endpoints", urlencoding::encode(team_id)),
            &body,
        )
        .await?;
        Ok(())
    }

    pub async fn unshare_endpoint(&self, team_id: &str, endpoint_id: &str) -> Result<()> {
        self.require_auth()?;
        self.delete(&format!(
            "/api/teams/{}/endpoints/{}",
            urlencoding::encode(team_id),
            urlencoding::encode(endpoint_id)
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
                &format!("/api/teams/{}/invite", urlencoding::encode(team_id)),
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
            &format!("/api/invites/{}/accept", urlencoding::encode(invite_id)),
            &body,
        )
        .await?;
        Ok(())
    }

    pub async fn decline_invite(&self, invite_id: &str) -> Result<()> {
        self.require_auth()?;
        let body = serde_json::json!({});
        self.post(
            &format!("/api/invites/{}/decline", urlencoding::encode(invite_id)),
            &body,
        )
        .await?;
        Ok(())
    }
}
