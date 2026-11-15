//! `whk billing checkout --wait --json`, end to end: the binary runs against
//! a local axum server that plays the checkout link routes.
//!
//! Run with: cargo test --test checkout

use axum::Json;
use axum::Router;
use axum::routing::get;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;

const ID: &str = "11111111-2222-4333-8444-555555555555";

fn link(status: &str) -> Value {
    json!({ "checkout": {
        "id": ID, "status": status, "kind": "plan",
        "summary": "The Pro plan, billed monthly.",
        "item": { "kind": "plan", "plan": "pro", "interval": "month" },
        "teamId": null,
        "url": if status == "open" { json!(format!("https://webhooks.test/checkout/{ID}")) } else { Value::Null },
        "createdAt": "2026-11-14T12:00:00.000Z", "expiresAt": "2026-11-14T13:00:00.000Z",
        "paidAt": if status == "paid" { json!("2026-11-14T12:05:00.000Z") } else { Value::Null }
    }})
}

/// The checkout routes: POST answers an open link; GET answers `statuses`
/// in turn, each after `delay`.
async fn server(statuses: Vec<&'static str>, delay: Duration) -> String {
    let polls = Arc::new(Mutex::new(0usize));
    let app = Router::new()
        .route(
            "/api/billing/checkouts",
            axum::routing::post(|| async { (axum::http::StatusCode::CREATED, Json(link("open"))) }),
        )
        .route(
            "/api/billing/checkouts/{id}",
            get(move || {
                let polls = polls.clone();
                let statuses = statuses.clone();
                async move {
                    tokio::time::sleep(delay).await;
                    let status = {
                        let mut n = polls.lock().unwrap();
                        let status = statuses[(*n).min(statuses.len() - 1)];
                        *n += 1;
                        status
                    };
                    Json(link(status))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A home of its own, so no saved login is read.
struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("whk-checkout-test-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn command(&self, base: &str, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_whk"));
        cmd.args(args)
            .env("WHK_API_URL", base)
            .env("WHK_WEBHOOK_URL", "http://receiver.test")
            .env("WHK_AUTH", "key")
            .env("WHK_API_KEY", "whcc_test")
            .env("WHK_AGENT_FILE", self.0.join("agent.json"))
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("APPDATA", self.0.join("config"))
            .env("NO_COLOR", "1")
            .kill_on_drop(true);
        cmd
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn wait_with_json_prints_one_line_per_answer() {
    let base = server(vec!["paid"], Duration::ZERO).await;
    let home = Home::new();
    let output = home
        .command(
            &base,
            &[
                "billing",
                "checkout",
                "plan",
                "--plan",
                "pro",
                "--wait",
                "--timeout",
                "1m",
                "--json",
            ],
        )
        .output()
        .await
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // NDJSON: every line parses on its own, the open link first (its URL
    // is what the person is handed) and the paid link last.
    let lines: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("{e}: {line}")))
        .collect();
    assert_eq!(lines.len(), 2, "{stdout}");
    assert_eq!(lines[0]["checkout"]["status"], "open");
    assert!(lines[0]["checkout"]["url"].is_string());
    assert_eq!(lines[1]["checkout"]["status"], "paid");
}

#[tokio::test]
async fn a_slow_poll_never_outlasts_the_timeout() {
    // The answer would say paid, but only after the wait has run out.
    let base = server(vec!["paid"], Duration::from_secs(10)).await;
    let home = Home::new();
    let started = Instant::now();
    let output = home
        .command(
            &base,
            &[
                "billing",
                "checkout-status",
                ID,
                "--wait",
                "--timeout",
                "1s",
                "--json",
            ],
        )
        .output()
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("\"timeout\""), "{stderr}");
    assert!(output.stdout.is_empty());
}
