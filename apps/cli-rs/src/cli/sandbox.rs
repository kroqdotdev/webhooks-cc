//! `whk sandbox`: webhook capture for agents without an account (auth.md
//! v0.6), and the claim that connects an agent to a human's account. Every
//! subcommand runs without prompts and supports `--json`; progress goes to
//! stderr, and only when `--json` is off. Registrations live in the agent
//! credential file shared with the MCP server and the SDKs; assertions and
//! tokens are never printed.

use anyhow::{Result, bail};
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Write;
use std::time::{Duration, Instant};

use crate::agent::credentials::{CredentialStore, Slot, SlotKind};
use crate::agent::pow::PowChallenge;
use crate::agent::protocol::{self, AgentError, ClaimPoll};
use crate::agent::sandbox::{Sandbox, registration_gone};
use crate::api::ApiClient;
use crate::auth;
use crate::cli::output::{
    bold, dim, green, print_request_detail, print_request_line, red, sanitize_line,
};
use crate::types::CapturedRequest;
use crate::util::format::{format_timestamp, parse_duration};

/// Captures one sandbox endpoint takes before it answers 429.
pub const SANDBOX_REQUESTS_PER_ENDPOINT: u32 = 25;
/// `wait` looks back this far by default, like the SDK's `waitFor`.
const WAIT_LOOKBACK_MS: i64 = 5 * 60 * 1000;
/// Each poll starts this far before the newest request seen, on the
/// server's clock, so a capture that committed late is not skipped.
const WAIT_OVERLAP_MS: i64 = 30 * 1000;
/// Sandbox reads are limited to 120 a minute per registration.
const WAIT_POLL: Duration = Duration::from_secs(1);
/// The server lists at most 100 requests.
const MAX_LIST: u32 = 100;

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn store_for(client: &ApiClient) -> CredentialStore {
    CredentialStore::locate(&client.base_url)
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

/// One line of JSON, flushed at once, for a caller reading as it goes.
fn print_json_line(value: &Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}

/// The saved sandbox, or an error that says how to get one.
fn require_sandbox(client: &ApiClient, store: &CredentialStore) -> Result<Sandbox> {
    match Sandbox::existing(&client.agent_http, &client.base_url, store) {
        Some(sandbox) => Ok(sandbox),
        None => bail!(
            "no_sandbox: no live sandbox registration is saved for {}. Run `whk sandbox create` first.",
            store.issuer()
        ),
    }
}

/// Adds a hint to errors that mean the saved sandbox is gone for good.
fn explain_gone(error: anyhow::Error) -> anyhow::Error {
    if !registration_gone(&error) {
        return error;
    }
    let code = protocol::error_code(&error).unwrap_or("gone").to_string();
    error.context(format!(
        "{code}: the saved sandbox registration is gone, and so are its endpoints. Run `whk sandbox create` to start a new one"
    ))
}

/// Registers anonymously, telling the user about the proof of work.
async fn register(client: &ApiClient, store: &CredentialStore, json: bool) -> Result<Sandbox> {
    let on_solve = |challenge: &PowChallenge| {
        if !json {
            eprintln!(
                "  {}",
                dim(&format!(
                    "Registering an anonymous sandbox: solving a proof of work ({} x 2^{} hashes, a few seconds)...",
                    challenge.count, challenge.difficulty
                ))
            );
        }
    };
    let (sandbox, full) =
        Sandbox::register(&client.agent_http, &client.base_url, store, &on_solve).await?;
    if full {
        eprintln!(
            "  {} The shared sandbox is full right now; creating an endpoint may answer sandbox_full.",
            red("!")
        );
    }
    Ok(sandbox)
}

/// The endpoint with its capture URL, filled in from the receiver URL when
/// the server left it out.
fn with_url(client: &ApiClient, mut endpoint: Value) -> Value {
    let missing = endpoint
        .get("url")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty);
    if missing
        && let Some(url) = endpoint
            .get("slug")
            .and_then(Value::as_str)
            .map(|slug| client.webhook_url_for(slug))
        && let Some(object) = endpoint.as_object_mut()
    {
        object.insert("url".into(), url.into());
    }
    endpoint
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn print_endpoint(endpoint: &Value) {
    let slug = sanitize_line(text(endpoint, "slug"));
    println!("  {} {}", dim("Slug:"), bold(&slug));
    println!("  {} {}", dim("URL:"), sanitize_line(text(endpoint, "url")));
    let limits = endpoint.get("sandbox").cloned().unwrap_or(Value::Null);
    let per_endpoint = limits
        .get("requestLimit")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(SANDBOX_REQUESTS_PER_ENDPOINT));
    let captured = endpoint
        .get("requestCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    println!("  {} {captured} of {per_endpoint}", dim("Captures:"));
    if let Some(budget) = limits.get("budget") {
        println!(
            "  {} {} of {} used across this registration",
            dim("Budget:"),
            budget.get("used").and_then(Value::as_u64).unwrap_or(0),
            budget.get("limit").and_then(Value::as_u64).unwrap_or(0)
        );
    }
    let expires = endpoint
        .get("expiresAt")
        .or_else(|| limits.get("expiresAt"))
        .and_then(Value::as_i64);
    if let Some(expires) = expires {
        println!("  {} {}", dim("Expires:"), format_timestamp(expires));
    }
}

pub async fn create(client: &ApiClient, json: bool) -> Result<()> {
    let store = store_for(client);
    if !json && store.load().claimed.is_some() {
        eprintln!(
            "  {}",
            dim(
                "This agent is connected to an account: `whk create` makes a regular endpoint there."
            )
        );
    }
    let (sandbox, reused) = match Sandbox::existing(&client.agent_http, &client.base_url, &store) {
        Some(sandbox) => (sandbox, true),
        None => (register(client, &store, json).await?, false),
    };
    let endpoint = match sandbox.create_endpoint().await {
        Err(error) if reused && registration_gone(&error) => {
            eprintln!(
                "  {} The saved sandbox registration is gone ({}); registering a new one.",
                red("!"),
                protocol::error_code(&error).unwrap_or("gone")
            );
            register(client, &store, json)
                .await?
                .create_endpoint()
                .await?
        }
        other => other?,
    };
    let endpoint = with_url(client, endpoint);
    if json {
        return print_json(&endpoint);
    }
    let slug = sanitize_line(text(&endpoint, "slug"));
    println!(
        "\n  {} Created sandbox endpoint {}",
        green("✓"),
        bold(&slug)
    );
    print_endpoint(&endpoint);
    println!(
        "\n  {}\n",
        dim(&format!(
            "Read captures with `whk sandbox requests {slug}` or `whk sandbox wait {slug}`."
        ))
    );
    Ok(())
}

pub async fn list(client: &ApiClient, json: bool) -> Result<()> {
    let store = store_for(client);
    let Some(sandbox) = Sandbox::existing(&client.agent_http, &client.base_url, &store) else {
        if json {
            return print_json(&json!({ "endpoints": [], "sandbox": null }));
        }
        println!(
            "  No sandbox yet. Create an endpoint with {}",
            bold("whk sandbox create")
        );
        return Ok(());
    };
    let mut result = sandbox.list_endpoints().await.map_err(explain_gone)?;
    if let Some(endpoints) = result.get_mut("endpoints").and_then(Value::as_array_mut) {
        for endpoint in endpoints.iter_mut() {
            *endpoint = with_url(client, endpoint.take());
        }
    }
    if json {
        return print_json(&result);
    }
    let endpoints = result
        .get("endpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let limits = result.get("sandbox").cloned().unwrap_or(Value::Null);
    if endpoints.is_empty() {
        println!(
            "  No sandbox endpoints. Create one with {}",
            bold("whk sandbox create")
        );
    } else {
        println!(
            "  {:<20} {:<10} {}",
            dim("SLUG"),
            dim("CAPTURES"),
            dim("URL")
        );
        for endpoint in &endpoints {
            let captured = endpoint
                .get("requestCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!(
                "  {:<20} {:<10} {}",
                bold(&sanitize_line(text(endpoint, "slug"))),
                format!("{captured}/{SANDBOX_REQUESTS_PER_ENDPOINT}"),
                dim(&sanitize_line(text(endpoint, "url")))
            );
        }
    }
    if let Some(budget) = limits.get("budget") {
        let mut line = format!(
            "{} of {} captures used; up to {} endpoints at a time",
            budget.get("used").and_then(Value::as_u64).unwrap_or(0),
            budget.get("limit").and_then(Value::as_u64).unwrap_or(0),
            limits
                .get("maxEndpoints")
                .and_then(Value::as_u64)
                .unwrap_or(3)
        );
        if let Some(expires) = limits.get("expiresAt").and_then(Value::as_i64) {
            line.push_str(&format!(
                "; everything expires {}",
                format_timestamp(expires)
            ));
        }
        println!("\n  {}", dim(&line));
    }
    Ok(())
}

pub async fn get(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let store = store_for(client);
    let sandbox = require_sandbox(client, &store)?;
    let endpoint = with_url(
        client,
        sandbox.get_endpoint(slug).await.map_err(explain_gone)?,
    );
    if json {
        return print_json(&endpoint);
    }
    print_endpoint(&endpoint);
    Ok(())
}

pub async fn delete(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let store = store_for(client);
    let sandbox = require_sandbox(client, &store)?;
    sandbox.delete_endpoint(slug).await.map_err(explain_gone)?;
    if json {
        return print_json(&json!({ "status": "deleted", "slug": slug }));
    }
    println!(
        "  {} Deleted sandbox endpoint {}",
        green("✓"),
        bold(&sanitize_line(slug))
    );
    Ok(())
}

/// Prints requests as the server sent them (`--json`) or one line each.
fn print_requests(list: &Value) {
    let items = list.as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        println!("  No requests captured yet.");
        return;
    }
    for item in items {
        match serde_json::from_value::<CapturedRequest>(item) {
            Ok(request) => print_request_line(&request),
            Err(_) => println!(
                "  {}",
                dim("(a request this version cannot show; use --json)")
            ),
        }
    }
}

fn print_request(value: &Value) {
    match serde_json::from_value::<CapturedRequest>(value.clone()) {
        Ok(request) => print_request_detail(&request),
        Err(_) => println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_default()
        ),
    }
}

pub async fn requests(
    client: &ApiClient,
    slug: &str,
    limit: Option<u32>,
    since: Option<i64>,
    json: bool,
) -> Result<()> {
    let store = store_for(client);
    let sandbox = require_sandbox(client, &store)?;
    let list = sandbox
        .list_requests(slug, since, limit)
        .await
        .map_err(explain_gone)?;
    if json {
        return print_json(&list);
    }
    print_requests(&list);
    Ok(())
}

pub async fn request(client: &ApiClient, id: &str, json: bool) -> Result<()> {
    let store = store_for(client);
    let sandbox = require_sandbox(client, &store)?;
    let value = sandbox.get_request(id).await.map_err(explain_gone)?;
    if json {
        return print_json(&value);
    }
    print_request(&value);
    Ok(())
}

/// Worth another poll: a network failure, a rate limit or a server error.
fn transient(error: &anyhow::Error) -> bool {
    match error.downcast_ref::<AgentError>() {
        Some(e) => e.status == 429 || e.status >= 500,
        None => true,
    }
}

/// How long the server asked to wait before the next try (`Retry-After`).
fn retry_after(error: &anyhow::Error) -> Option<Duration> {
    error
        .downcast_ref::<AgentError>()
        .and_then(|e| e.retry_after)
        .map(Duration::from_secs)
}

/// An email as the server keeps it: trimmed and lowercased.
fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

fn request_id(request: &Value) -> Option<String> {
    request
        .get("id")
        .or_else(|| request.get("_id"))
        .and_then(Value::as_str)
        .map(String::from)
}

pub async fn wait(
    client: &ApiClient,
    slug: &str,
    timeout: &str,
    since: Option<i64>,
    count: u32,
    json: bool,
) -> Result<()> {
    let timeout_ms = parse_duration(timeout)?;
    let store = store_for(client);
    let sandbox = require_sandbox(client, &store)?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
    let mut last_checked = since.unwrap_or_else(|| now_ms() - WAIT_LOOKBACK_MS);
    let mut seen = HashSet::new();
    let mut collected: Vec<Value> = Vec::new();
    if !json {
        eprintln!(
            "  {}",
            dim(&format!(
                "Waiting up to {timeout} for {count} request(s) at {slug}..."
            ))
        );
    }

    loop {
        let mut pause = WAIT_POLL;
        match sandbox
            .list_requests(slug, Some(last_checked), Some(MAX_LIST))
            .await
        {
            Ok(list) => {
                let mut items = list.as_array().cloned().unwrap_or_default();
                items.sort_by_key(|r| r.get("receivedAt").and_then(Value::as_i64).unwrap_or(0));
                for item in &items {
                    if let Some(at) = item.get("receivedAt").and_then(Value::as_i64) {
                        last_checked = last_checked.max(at - WAIT_OVERLAP_MS);
                    }
                }
                for item in items {
                    let Some(id) = request_id(&item) else {
                        continue;
                    };
                    if seen.insert(id) {
                        collected.push(item);
                    }
                    if collected.len() >= count as usize {
                        return print_waited(&collected, count, json);
                    }
                }
            }
            // A rate limit (other processes share the registration's reads)
            // is waited out before the next poll, as the server asks.
            Err(error) if transient(&error) => {
                if let Some(wait) = retry_after(&error) {
                    pause = pause.max(wait);
                }
            }
            Err(error) => return Err(explain_gone(error)),
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            bail!(
                "timeout: {} of {count} request(s) arrived at {slug} within {timeout}",
                collected.len()
            );
        }
        tokio::time::sleep(left.min(pause)).await;
    }
}

fn print_waited(collected: &[Value], count: u32, json: bool) -> Result<()> {
    if json {
        return if count == 1 {
            print_json(&collected[0])
        } else {
            print_json(&Value::Array(collected.to_vec()))
        };
    }
    if count == 1 {
        print_request(&collected[0]);
    } else {
        print_requests(&Value::Array(collected.to_vec()));
    }
    Ok(())
}

/// What the file says about a slot, without the assertion or token.
fn slot_summary(slot: &Slot) -> Value {
    let mut out = json!({
        "registration_id": slot.registration_id(),
        "assertion_expires": slot.assertion_expires(),
    });
    for key in ["email", "scope", "client_name", "saved_at"] {
        if let Some(value) = slot.info(key) {
            out[key] = value.into();
        }
    }
    out
}

pub async fn status(client: &ApiClient, json: bool) -> Result<()> {
    let store = store_for(client);
    let slots = store.load();
    let logged_in = auth::is_logged_in();
    let regular = if logged_in {
        "login"
    } else if slots.claimed.is_some() {
        "agent"
    } else {
        "none"
    };
    if json {
        return print_json(&json!({
            "issuer": store.issuer(),
            "credential_file": store.path().map(|p| p.display().to_string()),
            "logged_in": logged_in,
            "regular_commands": regular,
            "claimed": slots.claimed.as_ref().map(slot_summary),
            "sandbox": slots.sandbox.as_ref().map(slot_summary),
        }));
    }

    let file = store
        .path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "none (no home directory; set WHK_AGENT_FILE)".into());
    println!("  {} {}", dim("API:"), store.issuer());
    println!("  {} {}", dim("Credential file:"), file);
    match &slots.claimed {
        Some(slot) => println!(
            "  {} Connected to {} (registration {}, until {})",
            green("●"),
            bold(slot.info("email").unwrap_or("an account")),
            slot.registration_id(),
            slot.assertion_expires()
        ),
        None => println!("  {} No account connection", dim("●")),
    }
    match &slots.sandbox {
        Some(slot) => println!(
            "  {} Sandbox registration {} (until {})",
            green("●"),
            slot.registration_id(),
            slot.assertion_expires()
        ),
        None => println!("  {} No sandbox registration", dim("●")),
    }
    let note = match regular {
        "login" => "Regular commands use your `whk auth login` session.",
        "agent" => {
            "Regular commands (whk list, whk create, ...) act through the account connection."
        }
        _ => "Regular commands need `whk auth login` or `whk sandbox connect --email <address>`.",
    };
    println!("\n  {}", dim(note));
    Ok(())
}

/// How a connect attempt ended, for the second JSON line.
enum Outcome {
    Claimed,
    Declined,
    Expired,
    Timeout,
}

pub async fn connect(
    client: &ApiClient,
    email: &str,
    timeout: Option<&str>,
    json: bool,
) -> Result<()> {
    // Sent, stored and compared as the server keeps it, like the SDKs do.
    let email = normalize_email(email);
    if email.is_empty() {
        bail!("invalid_request: --email needs the address the human signs in with");
    }
    let email = email.as_str();
    let store = store_for(client);
    if let Some(slot) = store.load().claimed {
        if json {
            let mut line = slot_summary(&slot);
            line["status"] = "already_connected".into();
            print_json_line(&line);
        } else {
            let saved = slot.info("email");
            let same = saved.is_some_and(|saved| normalize_email(saved) == email);
            let advice = if same {
                String::new()
            } else {
                format!(
                    " Run {} first to connect {} instead.",
                    bold("whk sandbox forget --claimed"),
                    bold(email)
                )
            };
            println!(
                "  {} Already connected to {} (until {}).{advice}",
                green("●"),
                bold(saved.unwrap_or("an account")),
                slot.assertion_expires(),
            );
        }
        return Ok(());
    }
    let cap_ms = timeout.map(parse_duration).transpose()?;

    // A sandbox registered by an earlier process cannot be claimed: its
    // claim token was never saved. A service_auth registration asks the
    // human for the same code; the sandbox endpoints stay where they are.
    let registration =
        protocol::register_service_auth(&client.agent_http, &client.base_url, email).await?;
    let attempt = registration.claim.clone();
    if json {
        print_json_line(&json!({
            "status": "pending",
            "registration_id": registration.registration_id,
            "verification_uri": attempt.verification_uri,
            "user_code": attempt.user_code,
            "expires_at": crate::agent::credentials::format_timestamp(attempt.expires_at_ms),
            "email": email,
        }));
    } else {
        println!(
            "\n  Ask your human to open this link, sign in (or sign up) as {}, and enter the code:\n",
            bold(email)
        );
        println!("    {} {}", dim("Code:"), green(&bold(&attempt.user_code)));
        println!(
            "    {} {}\n",
            dim("Link:"),
            sanitize_line(&attempt.verification_uri)
        );
        println!(
            "  {}",
            dim(&format!(
                "The code works until {}. Waiting for the human...",
                format_timestamp(attempt.expires_at_ms)
            ))
        );
        let _ = std::io::stdout().flush();
    }

    let mut deadline_ms = attempt.expires_at_ms;
    if let Some(cap) = cap_ms {
        deadline_ms = deadline_ms.min(now_ms() + cap);
    }
    let mut interval = Duration::from_secs(attempt.interval.max(1));
    let outcome = loop {
        let left = deadline_ms - now_ms();
        if left <= 0 {
            break Outcome::Timeout;
        }
        tokio::time::sleep(interval.min(Duration::from_millis(left as u64))).await;
        match protocol::poll_claim(
            &client.agent_http,
            &client.base_url,
            &registration.claim_token,
        )
        .await
        {
            Ok(ClaimPoll::Pending) => {}
            Ok(ClaimPoll::SlowDown) => interval += Duration::from_secs(5),
            Ok(ClaimPoll::Expired) => break Outcome::Expired,
            Ok(ClaimPoll::Denied) => break Outcome::Declined,
            Ok(ClaimPoll::Claimed {
                token,
                identity_assertion,
                assertion_expires,
            }) => {
                let Some(mut slot) = Slot::new(
                    &registration.registration_id,
                    &identity_assertion,
                    &assertion_expires,
                    &[
                        ("scope", token.scope.as_str()),
                        ("email", email),
                        ("client_name", protocol::CLIENT_NAME),
                    ],
                ) else {
                    bail!("malformed response: assertion_expires is not a timestamp");
                };
                slot.set_token(&token.access_token, token.expires_at_ms);
                store.save(SlotKind::Claimed, &slot);
                store.remove_registration(SlotKind::Sandbox, &registration.registration_id);
                if json {
                    let mut line = slot_summary(&slot);
                    line["status"] = "claimed".into();
                    print_json_line(&line);
                } else {
                    println!(
                        "\n  {} Connected to {}'s account. When you are not logged in, regular commands (whk list, whk create, whk requests, ...) act for it.",
                        green("✓"),
                        bold(email)
                    );
                    if auth::is_logged_in() {
                        println!(
                            "  {}",
                            dim("You are logged in with `whk auth login`; that login still wins.")
                        );
                    }
                }
                break Outcome::Claimed;
            }
            Err(error) if transient(&error) => {
                if let Some(wait) = retry_after(&error) {
                    interval = interval.max(wait);
                }
            }
            Err(error) => return Err(error),
        }
    };

    let (status, message) = match outcome {
        Outcome::Claimed => return Ok(()),
        Outcome::Declined => (
            "declined",
            "access_denied: the human declined the connection",
        ),
        Outcome::Expired => (
            "expired",
            "expired_token: the code expired before it was entered. Run `whk sandbox connect` again for a new one",
        ),
        Outcome::Timeout => (
            "timeout",
            "timeout: the human did not connect the agent in time",
        ),
    };
    if json {
        print_json_line(
            &json!({ "status": status, "registration_id": registration.registration_id }),
        );
    }
    bail!("{message}")
}

pub async fn forget(client: &ApiClient, claimed: bool, sandbox: bool, json: bool) -> Result<()> {
    let store = store_for(client);
    let held = store.load();
    let mut removed = Vec::new();
    for (wanted, kind) in [(claimed, SlotKind::Claimed), (sandbox, SlotKind::Sandbox)] {
        if wanted && held.get(kind).is_some() {
            store.remove(kind);
            removed.push(kind.key());
        }
    }
    if json {
        return print_json(&json!({ "status": "forgotten", "removed": removed }));
    }
    if removed.is_empty() {
        println!("  Nothing to forget for {}.", store.issuer());
        return Ok(());
    }
    println!(
        "  {} Removed {} from the credential file.",
        green("✓"),
        removed.join(" and ")
    );
    if claimed && removed.contains(&"claimed") {
        println!(
            "  {}",
            dim(
                "The connection itself stays until it expires; the human can disconnect it under Account, Connected agents."
            )
        );
    }
    Ok(())
}
