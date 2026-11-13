//! `whk keys` and `whk approvals`: the account's API keys. Listing and
//! revoking act at once; a new key needs the account's owner to approve it
//! on a web page, the way a login does (`whk auth login`): whk prints the
//! link and the code to compare, waits for the answer, and prints the key
//! once.

use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::auth::remote_session;
use crate::cli::output::{bold, dim, green, red, sanitize};
use crate::error::CliError;
use crate::types::{Approval, ApprovalAnswer};
use crate::util::format::format_timestamp;

// Tests poll quickly; the server's own pace is one poll every two seconds.
const POLL_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(20)
} else {
    Duration::from_secs(2)
};

pub async fn list(client: &ApiClient, json: bool) -> Result<()> {
    let keys = client.list_api_keys().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&keys.json())?);
        return Ok(());
    }
    if keys.is_empty() {
        println!("  No API keys. Create one with `whk keys create <name>`.");
        return Ok(());
    }
    for key in keys.iter() {
        println!("  {}  {}", bold(&sanitize(&key.name)), dim(&key.key_prefix));
        let expires = key
            .expires_at
            .as_deref()
            .map(format_timestamp_str)
            .unwrap_or_else(|| "never".into());
        let used = key
            .last_used_at
            .as_deref()
            .map(format_timestamp_str)
            .unwrap_or_else(|| "never".into());
        println!(
            "    {}",
            dim(&format!(
                "id {}  created {}  expires {}  last used {}",
                key.id,
                format_timestamp_str(&key.created_at),
                expires,
                used
            ))
        );
    }
    Ok(())
}

fn format_timestamp_str(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|t| format_timestamp(t.timestamp_millis()))
        .unwrap_or_else(|_| iso.to_string())
}

pub struct CreateOptions {
    pub expires_in_days: Option<u32>,
    pub remote: bool,
    pub no_browser: bool,
    pub no_wait: bool,
    pub timeout: String,
}

pub async fn create(client: &ApiClient, name: &str, opts: CreateOptions, json: bool) -> Result<()> {
    let deadline = deadline(&opts.timeout)?;
    let answer = client.create_api_key(name, opts.expires_in_days).await?;

    // A browser session gets the key at once; whk never holds one, but the
    // answer is printed the same way if it ever does.
    let Some(raw_approval) = answer.get("approval") else {
        print_key(&answer, None, json);
        return Ok(());
    };
    let approval: Approval = serde_json::from_value(raw_approval.clone())?;

    show_approval(&approval, raw_approval, opts.remote, opts.no_browser, json);
    if opts.no_wait {
        if !json {
            println!(
                "\n  When it is approved, run {} to collect the key.",
                bold(&format!("whk approvals wait {}", approval.id))
            );
        }
        return Ok(());
    }
    collect(client, &approval.id, deadline, json).await
}

pub async fn wait(client: &ApiClient, id: &str, timeout: &str, json: bool) -> Result<()> {
    let deadline = deadline(timeout)?;
    collect(client, id, deadline, json).await
}

pub async fn revoke(client: &ApiClient, id: &str, yes: bool, json: bool) -> Result<()> {
    crate::cli::confirm::confirm(
        &format!("Revoke API key {id}? Anything using it stops working at once."),
        yes,
    )?;
    client.revoke_api_key(id).await?;
    if json {
        println!("{}", json!({ "revoked": id }));
    } else {
        println!("  {} Revoked API key {}", red("✓"), bold(id));
    }
    Ok(())
}

fn deadline(timeout: &str) -> Result<Instant> {
    let ms = crate::cli::wait::parse_timeout(timeout)?;
    Ok(Instant::now() + Duration::from_millis(ms.max(0) as u64))
}

/// Shows the person what to approve, as `whk auth login` does: the link,
/// and the code the page shows. The browser opens on this machine's own
/// desktop only.
fn show_approval(approval: &Approval, raw: &Value, remote: bool, no_browser: bool, json: bool) {
    let remote = remote || remote_session(|name| std::env::var(name).ok());
    if json {
        println!("{}", json!({ "status": "pending", "approval": raw }));
        return;
    }
    println!("\n  {}", sanitize(&approval.summary));
    println!("\n  Open this link to approve it:\n");
    println!("    {}\n", bold(&approval.url));
    println!(
        "  The page shows the code {}: approve only if it matches.",
        green(&approval.code)
    );
    if remote {
        println!(
            "  {}",
            dim("This looks like another machine: open the link in your own browser.")
        );
    } else if !no_browser && approval.url.starts_with("https://") {
        let _ = open::that(&approval.url);
    }
    println!("\n  Waiting for approval...");
}

/// Polls the approval until the person answers, then prints what it granted.
async fn collect(client: &ApiClient, id: &str, deadline: Instant, json: bool) -> Result<()> {
    loop {
        let answer = client.get_approval(id).await?;
        let ApprovalAnswer { approval, result } = &answer.value;
        match approval.status.as_str() {
            "completed" => {
                let Some(result) = result else {
                    return Err(CliError::Usage(
                        "this approval was already collected: what it granted is only handed over once"
                            .into(),
                    )
                    .into());
                };
                print_key(result, Some(&answer.raw["approval"]), json);
                return Ok(());
            }
            "denied" => return Err(CliError::ApprovalDenied.into()),
            "expired" => return Err(CliError::ApprovalExpired.into()),
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(CliError::Timeout(format!(
                "Not answered yet. Run `whk approvals wait {id}` to keep waiting."
            ))
            .into());
        }
        tokio::time::sleep(POLL_EVERY).await;
    }
}

/// The new key, printed once.
fn print_key(result: &Value, approval: Option<&Value>, json: bool) {
    if json {
        let mut line = json!({ "status": "completed", "result": result });
        if let Some(approval) = approval {
            line["approval"] = approval.clone();
        }
        println!("{line}");
        return;
    }
    let key = result.get("key").and_then(Value::as_str).unwrap_or("");
    let name = result.get("name").and_then(Value::as_str).unwrap_or("");
    let expires = result
        .get("expiresAt")
        .and_then(Value::as_str)
        .map(format_timestamp_str)
        .unwrap_or_default();
    println!(
        "\n  {} API key {}",
        green("Approved."),
        bold(&sanitize(name))
    );
    println!("\n    {}\n", bold(key));
    println!(
        "  {}",
        dim("This is the only time it is shown: store it now, for example as a CI secret.")
    );
    if !expires.is_empty() {
        println!("  {}", dim(&format!("It works until {expires}.")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::{get, post};
    use std::sync::{Arc, Mutex};

    const ID: &str = "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

    fn approval(status: &str) -> Value {
        json!({
            "id": ID,
            "status": status,
            "action": "api_keys.create",
            "summary": "Create an API key named \"CI\" with full access to your account for 90 days.",
            "code": "ABCD-EFGH",
            "url": "https://webhooks.cc/approve?code=ABCD-EFGH",
            "expiresAt": "2026-11-13T12:15:00.000Z",
        })
    }

    /// A server whose polls answer `statuses` in turn (the last repeats).
    async fn server(statuses: Vec<&'static str>) -> (String, Arc<Mutex<Option<Value>>>) {
        let asked: Arc<Mutex<Option<Value>>> = Arc::default();
        let seen = asked.clone();
        let polls = Arc::new(Mutex::new(0usize));
        let app = Router::new()
            .route(
                "/api/api-keys",
                post(move |axum::Json(body): axum::Json<Value>| async move {
                    *seen.lock().unwrap() = Some(body);
                    (
                        axum::http::StatusCode::ACCEPTED,
                        axum::Json(json!({ "approval": approval("pending") })),
                    )
                }),
            )
            .route(
                "/api/approvals/{id}",
                get(move || {
                    let polls = polls.clone();
                    let statuses = statuses.clone();
                    async move {
                        let mut n = polls.lock().unwrap();
                        let status = statuses[(*n).min(statuses.len() - 1)];
                        *n += 1;
                        let mut body = json!({ "approval": approval(status) });
                        if status == "completed" {
                            body["result"] = json!({
                                "key": "whcc_new", "name": "CI", "keyPrefix": "whcc_new",
                                "expiresAt": "2027-02-11T12:00:00.000Z",
                            });
                        }
                        axum::Json(body)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, asked)
    }

    fn client(base: &str) -> ApiClient {
        ApiClient::with_credentials(Some(base), Some(base), Some("whcc_test".into()), None).unwrap()
    }

    fn options() -> CreateOptions {
        CreateOptions {
            expires_in_days: Some(30),
            remote: true,
            no_browser: true,
            no_wait: false,
            timeout: "1m".into(),
        }
    }

    #[tokio::test]
    async fn asks_then_collects_the_key_once_approved() {
        let (base, asked) = server(vec!["pending", "completed"]).await;
        create(&client(&base), "CI", options(), true).await.unwrap();
        let body = asked.lock().unwrap().clone().unwrap();
        assert_eq!(body, json!({ "name": "CI", "expiresInDays": 30 }));
    }

    #[tokio::test]
    async fn a_refused_approval_is_approval_denied() {
        let (base, _) = server(vec!["pending", "denied"]).await;
        let error = create(&client(&base), "CI", options(), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("approval_denied", 9));
    }

    #[tokio::test]
    async fn an_expired_approval_is_approval_expired() {
        let (base, _) = server(vec!["expired"]).await;
        let error = wait(&client(&base), ID, "1m", true).await.unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("approval_expired", 8));
    }

    #[tokio::test]
    async fn waiting_past_the_timeout_says_how_to_resume() {
        let (base, _) = server(vec!["pending"]).await;
        let error = wait(&client(&base), ID, "1s", true).await.unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "timeout");
        assert!(format!("{error:#}").contains(&format!("whk approvals wait {ID}")));
    }

    #[tokio::test]
    async fn no_wait_stops_after_asking() {
        let (base, _) = server(vec!["pending"]).await;
        let mut opts = options();
        opts.no_wait = true;
        create(&client(&base), "CI", opts, true).await.unwrap();
    }
}
