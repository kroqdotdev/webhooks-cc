//! The web app's internal API (apps/web/app/api/edge), over the private
//! network with the shared secret: it decides whether a share or a live
//! session may open, under what name and for how long, and keeps the
//! record. The edge only carries the traffic.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::door::Door;
use crate::meter::Batch;

#[derive(Clone)]
pub struct Web {
    http: reqwest::Client,
    base: String,
    secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub share_id: String,
    pub user_id: String,
    pub name: String,
    pub url: String,
    pub expires_at: Option<String>,
    /// Seconds until the plan's time runs out, if it has a limit.
    pub expires_in: Option<u64>,
    /// Whether visitors see the notice first (Free, and new paid accounts).
    #[serde(default)]
    pub notice: bool,
    /// The version of the password visitors need, if any (gate.rs).
    #[serde(default)]
    pub gate: Option<String>,
    /// The endpoint whose captures come down the tunnel, for a live
    /// session (relay.rs); none for a share.
    #[serde(default)]
    pub endpoint_id: Option<String>,
}

/// A share's password version as the web app has it now.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub share_id: String,
    pub gate: Option<String>,
}

/// A share the web app wants closed, and the words for the CLI.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Close {
    pub share_id: String,
    pub reason: String,
}

#[derive(Deserialize)]
pub struct SyncAnswer {
    pub close: Vec<Close>,
    #[serde(default)]
    pub gates: Vec<Gate>,
    /// Accounts past their plan's data for the month (meter.rs).
    #[serde(default)]
    pub over: Vec<String>,
}

/// Why a share was refused: the web app's status and words, for the CLI.
#[derive(Debug)]
pub struct Refused {
    pub status: u16,
    pub error: String,
}

/// What `whk share` (or `whk tunnel --live`) asked for, as the web app is
/// asked whether it may open.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest<'a> {
    pub api_key: &'a str,
    pub name: Option<&'a str>,
    pub client: &'a str,
    pub instance: Option<&'a str>,
    /// Where the CLI connected from, kept with the share for abuse cases.
    pub address: &'a str,
    /// From `whk share --password`; the web app keeps only a hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<&'a str>,
    /// `"share"` or `"live"`.
    pub kind: &'a str,
    /// The endpoint's slug, for a live session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<&'a str>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

impl Web {
    pub fn new(config: &Config) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("an HTTP client"),
            base: config.web_url.trim_end_matches('/').to_string(),
            secret: config.edge_secret.clone(),
        }
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .post(format!("{}{}", self.base, path))
            .bearer_auth(&self.secret)
    }

    /// Tells the web app the edge started: every share it had is gone.
    /// Tries until the web app answers.
    pub async fn started(&self) {
        let mut wait = Duration::from_secs(1);
        loop {
            match self.post("/api/edge/start").send().await {
                Ok(r) if r.status().is_success() => {
                    tracing::info!("web app told of the start");
                    return;
                }
                Ok(r) => tracing::warn!(status = %r.status(), "web app refused the start"),
                Err(e) => tracing::warn!(error = %e, "web app not reachable yet"),
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(30));
        }
    }

    pub async fn open(&self, request: &OpenRequest<'_>) -> Result<Opened, Refused> {
        let response = self
            .post("/api/edge/open")
            .json(request)
            .send()
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "web app not reachable");
                Refused {
                    status: 503,
                    error: "webhooks.cc could not check your key just now. Try again in a moment."
                        .into(),
                }
            })?;
        let status = response.status();
        if status.is_success() {
            return response.json::<Opened>().await.map_err(|e| {
                tracing::error!(error = %e, "web app answered oddly");
                Refused {
                    // Not 502: Cloudflare would swap it for its own page,
                    // and the CLI would lose these words.
                    status: 503,
                    error: "webhooks.cc answered oddly. Try again in a moment.".into(),
                }
            });
        }
        let error = response
            .json::<ErrorBody>()
            .await
            .map(|b| b.error)
            .unwrap_or_else(|_| "The share was refused.".into());
        Err(Refused {
            status: status.as_u16(),
            error,
        })
    }

    /// Asks which of the shares and live sessions open here have ended at
    /// the web app: stopped while the edge was not told, or their account
    /// deleted, and hands over what visitors took since the last round
    /// (meter.rs). None when the web app does not answer; the next round
    /// asks again.
    pub async fn sync(&self, share_ids: &[String], batches: &[Batch]) -> Option<SyncAnswer> {
        let body = serde_json::json!({
            "shareIds": share_ids,
            "batches": batches,
        });
        let response = self.post("/api/edge/sync").json(&body).send().await;
        match response {
            Ok(r) if r.status().is_success() => r.json::<SyncAnswer>().await.ok(),
            Ok(r) => {
                tracing::warn!(status = %r.status(), "web app refused the sync");
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "web app not reachable for the sync");
                None
            }
        }
    }

    /// Checks a password a visitor typed (gate.rs): the version it opens,
    /// `Some(None)` when it is wrong, `None` when the web app did not answer.
    pub async fn unlock(&self, door: &Door, password: &str) -> Option<Option<String>> {
        #[derive(Deserialize)]
        struct Answer {
            ok: bool,
            version: Option<String>,
        }
        let mut body = serde_json::json!({ "password": password });
        body[door.id_field()] = door.id.clone().into();
        match self.post("/api/edge/unlock").json(&body).send().await {
            Ok(r) if r.status().is_success() => {
                let answer = r.json::<Answer>().await.ok()?;
                Some(answer.version.filter(|_| answer.ok))
            }
            Ok(r) => {
                tracing::warn!(status = %r.status(), "web app refused the unlock");
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "web app not reachable for an unlock");
                None
            }
        }
    }

    /// Tells the web app a page looks like phishing (inject.rs), for staff
    /// to look at. Failures are logged; the share is not flagged again.
    pub async fn flag(&self, door: &Door, url: &str, why: &[String], in_browser: bool) {
        let id = door.id.as_str();
        let mut body = serde_json::json!({
            "url": url,
            "signals": why,
            "seenIn": if in_browser { "browser" } else { "page" },
        });
        body[door.id_field()] = door.id.clone().into();
        match self.post("/api/edge/flag").json(&body).send().await {
            Ok(r) if r.status().is_success() => {
                tracing::info!(id, "flagged as possible phishing")
            }
            Ok(r) => tracing::warn!(status = %r.status(), id, "flag refused"),
            Err(e) => tracing::warn!(error = %e, id, "flag not delivered"),
        }
    }

    /// Records that a share closed. Failures are logged; the next start
    /// closes whatever was missed.
    pub async fn closed(&self, share_id: &str, reason: &str) {
        let body = serde_json::json!({ "shareId": share_id, "reason": reason });
        if let Err(e) = self.post("/api/edge/close").json(&body).send().await {
            tracing::warn!(error = %e, share_id, "close not recorded");
        }
    }
}
