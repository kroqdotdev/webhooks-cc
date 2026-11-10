//! Shares and reserved names (`whk share`, `whk shares`, `whk names`), as
//! the web app's `/api/shares` and `/api/tunnel-names` answer them.

use serde::{Deserialize, Serialize};

/// A time from the API: an ISO 8601 string, or milliseconds since the
/// epoch. Kept as it came, so `--json` passes it on unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ApiTime {
    Millis(i64),
    Text(String),
}

impl ApiTime {
    /// The time in UTC, when it reads as one.
    pub fn utc(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        use chrono::{DateTime, TimeZone, Utc};
        match self {
            ApiTime::Millis(ms) => Utc.timestamp_millis_opt(*ms).single(),
            ApiTime::Text(text) => DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|t| t.with_timezone(&Utc)),
        }
    }

    /// The time for a table: "2026-11-10 14:03", in the local zone.
    pub fn display(&self) -> String {
        use chrono::{DateTime, Local, TimeZone, Utc};
        let utc: Option<DateTime<Utc>> = match self {
            ApiTime::Millis(ms) => Utc.timestamp_millis_opt(*ms).single(),
            ApiTime::Text(text) => DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|t| t.with_timezone(&Utc)),
        };
        match (utc, self) {
            (Some(t), _) => t.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string(),
            (None, ApiTime::Text(text)) => text.clone(),
            (None, ApiTime::Millis(ms)) => ms.to_string(),
        }
    }
}

/// Who started a teammate's share, or reserved a team's name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Person {
    Detailed {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        email: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
    Plain(String),
}

impl Person {
    pub fn label(&self) -> String {
        match self {
            Person::Plain(text) => text.clone(),
            Person::Detailed {
                email, name, id, ..
            } => email
                .clone()
                .or_else(|| name.clone())
                .or_else(|| id.clone())
                .unwrap_or_else(|| "-".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    /// "share" (a preview at a name) or "live" (`whk tunnel --live`).
    #[serde(default = "share_kind")]
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub endpoint_slug: Option<String>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub started_at: Option<ApiTime>,
    #[serde(default)]
    pub ended_at: Option<ApiTime>,
    #[serde(default)]
    pub end_reason: Option<String>,
    #[serde(default)]
    pub expires_at: Option<ApiTime>,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub requests: u64,
    #[serde(default)]
    pub password: bool,
    /// Whether the caller started it (else a teammate did, under a team name).
    #[serde(default = "yes")]
    pub mine: bool,
    #[serde(default)]
    pub started_by: Option<Person>,
    /// Whether visitors see the notice page first.
    #[serde(default)]
    pub notice: Option<bool>,
    /// Whatever else the API sends, kept for `--json`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn share_kind() -> String {
    "share".to_string()
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelUsage {
    #[serde(default)]
    pub month: Option<String>,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub limit_bytes: Option<u64>,
    #[serde(default)]
    pub over: bool,
    #[serde(default)]
    pub resets_at: Option<ApiTime>,
    /// Why previews are paused and until when, while `over`.
    #[serde(default)]
    pub message: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelLimits {
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub shares: Option<u32>,
    #[serde(default)]
    pub reserved_names: Option<u32>,
    /// None: no time limit.
    #[serde(default)]
    pub session_minutes: Option<u32>,
    #[serde(default)]
    pub data_gb: Option<u64>,
    #[serde(default)]
    pub passwords: bool,
    #[serde(default)]
    pub notice: bool,
    /// The plan's name for people: "Pro", "Team Business".
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `GET /api/shares`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharesResponse {
    #[serde(default)]
    pub shares: Vec<Share>,
    #[serde(default)]
    pub usage: Option<TunnelUsage>,
    #[serde(default)]
    pub limits: Option<TunnelLimits>,
    /// Reserved names against the plan: `{limit, used, usable}`.
    #[serde(default)]
    pub names: Option<serde_json::Value>,
    /// Sharing is suspended on this account.
    #[serde(default)]
    pub suspended: bool,
    /// What to do next, as whk commands.
    #[serde(default)]
    pub hints: Vec<String>,
    /// Whatever else the API sends, kept for `--json`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One request a share answered, from the edge's memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub ms: Option<u64>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub at: Option<ApiTime>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub visitor: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareRequestsResponse {
    /// False when the edge could not be asked just now.
    #[serde(default = "yes")]
    pub available: bool,
    /// Newest first.
    #[serde(default)]
    pub requests: Vec<ShareRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRef {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// A reserved name the caller may share under.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelName {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub team: Option<TeamRef>,
    #[serde(default)]
    pub reserved_by: Option<Person>,
    #[serde(default = "yes")]
    pub mine: bool,
    #[serde(default)]
    pub password: bool,
    #[serde(default)]
    pub live: bool,
    /// False for a name the plan no longer covers (past its count after a
    /// downgrade, or a team whose subscription ended): kept, but nothing
    /// can be shared under it until the plan grows or another is released.
    #[serde(default = "yes")]
    pub usable: bool,
    #[serde(default)]
    pub created_at: Option<ApiTime>,
}

/// A team's names and how many it may keep, when the API gives them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamNameCount {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// False while the team has no subscription.
    #[serde(default = "yes")]
    pub active: bool,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub used: Option<u32>,
}

/// `GET /api/tunnel-names`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamesResponse {
    #[serde(default)]
    pub names: Vec<TunnelName>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub used: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Each team's own count, when the API gives it (team names count
    /// against the team, not the person who kept them).
    #[serde(
        default,
        alias = "teamNames",
        alias = "teamCounts",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub teams: Vec<TeamNameCount>,
}

/// `POST /api/tunnel-names`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservedName {
    pub name: TunnelName,
}

/// `PUT` or `DELETE /api/tunnel-names/{name}/password`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamePassword {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub password: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_parse_the_contract_shape() {
        let json = r#"{
            "shares": [{
                "id": "sh_1", "kind": "share", "name": "acme", "url": "https://acme.sharehooks.cc",
                "endpointSlug": null, "client": "laptop, Linux",
                "startedAt": "2026-11-10T12:00:00.000Z", "endedAt": null, "endReason": null,
                "expiresAt": null, "bytes": 2048, "requests": 3, "password": true,
                "mine": false, "startedBy": {"id": "u1", "email": "pat@example.com"}
            }, {
                "id": "sh_2", "kind": "live", "name": "abc123", "url": "https://go.webhooks.cc/w/abc123",
                "endpointSlug": "abc123", "startedAt": 1762776000000
            }],
            "usage": {"month": "2026-11", "bytes": 10, "limitBytes": 1073741824, "over": false, "resetsAt": "2026-12-01T00:00:00Z"},
            "limits": {"plan": "free", "shares": 1, "reservedNames": 0, "sessionMinutes": 120, "dataGb": 1, "passwords": false, "notice": true}
        }"#;
        let parsed: SharesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.shares.len(), 2);
        let first = &parsed.shares[0];
        assert!(first.password && !first.mine);
        assert_eq!(
            first.started_by.as_ref().unwrap().label(),
            "pat@example.com"
        );
        assert_eq!(parsed.shares[1].kind, "live");
        assert_eq!(
            parsed.shares[1].started_at,
            Some(ApiTime::Millis(1762776000000))
        );
        assert!(parsed.shares[1].mine, "mine defaults to true");
        let limits = parsed.limits.unwrap();
        assert_eq!(limits.session_minutes, Some(120));
        assert!(limits.notice);
        assert_eq!(parsed.usage.unwrap().limit_bytes, Some(1 << 30));
    }

    #[test]
    fn names_parse_the_contract_shape() {
        let json = r#"{"names":[{"name":"acme","url":"https://acme.sharehooks.cc","team":{"id":"t1","name":"Acme"},"reservedBy":{"id":"u1","email":"pat@example.com"},"mine":false,"password":true,"live":true,"createdAt":"2026-11-10T12:00:00Z"}],"limit":3,"used":1}"#;
        let parsed: NamesResponse = serde_json::from_str(json).unwrap();
        let name = &parsed.names[0];
        assert_eq!(name.team.as_ref().unwrap().name.as_deref(), Some("Acme"));
        assert!(name.password && name.live && !name.mine);
        assert_eq!((parsed.limit, parsed.used), (Some(3), Some(1)));
        let reserved: ReservedName =
            serde_json::from_str(r#"{"name":{"name":"acme","team":null,"reservedBy":null}}"#)
                .unwrap();
        assert_eq!(reserved.name.name, "acme");
    }

    #[test]
    fn times_read_either_way() {
        assert_eq!(ApiTime::Text("not a time".into()).display(), "not a time");
        assert!(!ApiTime::Millis(1762776000000).display().is_empty());
        assert!(
            ApiTime::Text("2026-11-10T12:00:00Z".into())
                .display()
                .starts_with("2026-11-1")
        );
    }
}
