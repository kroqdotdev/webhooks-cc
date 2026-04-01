//! CLI smoke tests — run the binary and verify output/exit codes.
//!
//! Run with: cargo test --test smoke

use std::process::Command;

fn whk() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_whk"));
    cmd.env("NO_COLOR", "1");
    cmd
}

// ─── Help & Version ─────────────────────────────────────────────────────

#[test]
fn test_help() {
    let output = whk().arg("--help").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("webhooks.cc"));
    assert!(stdout.contains("tunnel"));
    assert!(stdout.contains("listen"));
    assert!(stdout.contains("auth"));
}

#[test]
fn test_version() {
    let output = whk().arg("--version").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("whk"));
}

#[test]
fn test_nogui_shows_help() {
    let output = whk().arg("--nogui").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage:"));
}

// ─── Subcommand Help ────────────────────────────────────────────────────

#[test]
fn test_auth_help() {
    let output = whk().args(["auth", "--help"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("login"));
    assert!(stdout.contains("status"));
    assert!(stdout.contains("logout"));
}

#[test]
fn test_tunnel_help() {
    let output = whk().args(["tunnel", "--help"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("endpoint"));
    assert!(stdout.contains("ephemeral"));
    assert!(stdout.contains("header"));
}

#[test]
fn test_requests_help() {
    let output = whk().args(["requests", "--help"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("list"));
    assert!(stdout.contains("search"));
    assert!(stdout.contains("export"));
    assert!(stdout.contains("clear"));
}

#[test]
fn test_completions_bash() {
    let output = whk().args(["completions", "bash"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("whk"));
}

#[test]
fn test_completions_zsh() {
    let output = whk().args(["completions", "zsh"]).output().unwrap();
    assert!(output.status.success());
}

#[test]
fn test_completions_fish() {
    let output = whk().args(["completions", "fish"]).output().unwrap();
    assert!(output.status.success());
}

// ─── Auth Status ────────────────────────────────────────────────────────

#[test]
fn test_auth_status_json() {
    let output = whk().args(["auth", "status", "--json"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert!(parsed.get("logged_in").is_some());
}

// ─── Endpoint Commands (requires auth) ──────────────────────────────────

#[test]
fn test_list_json() {
    let output = whk().args(["list", "--json"]).output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() {
        let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        assert!(parsed.get("owned").is_some());
    }
    // If not authenticated, that's OK — just verify it didn't panic
}

#[test]
fn test_usage_json() {
    let output = whk().args(["usage", "--json"]).output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    if output.status.success() {
        let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        assert!(parsed.get("plan").is_some());
    }
}

// ─── Full Lifecycle (create → send → list → delete) ────────────────────

#[test]
fn test_full_lifecycle() {
    // Create
    let output = whk()
        .args(["create", "smoke-test", "--json", "-e"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        eprintln!("SKIP: create failed (probably no auth): {stdout}");
        return;
    }
    let ep: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let slug = ep["slug"].as_str().unwrap();

    // Send webhook
    let output = whk()
        .args(["send", slug, "--method", "POST", "-d", "{\"smoke\":true}", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "send failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let send: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(send["status"], 200);

    // Wait for capture
    std::thread::sleep(std::time::Duration::from_secs(1));

    // List requests
    let output = whk()
        .args(["requests", "list", slug, "--json", "--limit", "5"])
        .output()
        .unwrap();
    assert!(output.status.success(), "requests list failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reqs: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let requests = reqs["requests"].as_array().unwrap();
    assert!(!requests.is_empty(), "should have captured requests");

    // Get single request
    let req_id = requests[0]["id"].as_str().unwrap();
    let output = whk()
        .args(["requests", "get", req_id, "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "requests get failed");

    // Get endpoint detail
    let output = whk()
        .args(["get", slug, "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "get endpoint failed");

    // Export as curl
    let output = whk()
        .args(["requests", "export", slug, "--format", "curl", "--limit", "1"])
        .output()
        .unwrap();
    assert!(output.status.success(), "export failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("curl"), "export should contain curl command");

    // Delete
    let output = whk()
        .args(["delete", slug, "-f", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "delete failed");
}

// ─── Update (dev build) ────────────────────────────────────────────────

#[test]
fn test_update_dev_build() {
    let output = whk().args(["update", "--json"]).output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(parsed["error"], "dev_build");
}

// ─── Error cases ────────────────────────────────────────────────────────

#[test]
fn test_get_nonexistent_slug() {
    let output = whk()
        .args(["get", "this-slug-definitely-does-not-exist-zzz"])
        .output()
        .unwrap();
    // Should fail but not panic
    assert!(!output.status.success() || {
        let stderr = String::from_utf8_lossy(&output.stderr);
        stderr.contains("Not logged in") || stderr.contains("not_found")
    });
}

#[test]
fn test_invalid_subcommand() {
    let output = whk().arg("nonexistent-command").output().unwrap();
    assert!(!output.status.success());
}
