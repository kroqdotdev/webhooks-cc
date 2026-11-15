//! `whk billing`: what the account pays for, changes to it, and checkout
//! links. A change (a plan, seats, add-ons, cancelling or keeping the plan)
//! asked with an API key or agent token is quoted and waits for the
//! account's owner to approve it on a web page; approving makes it only while
//! the quote still holds. A checkout link (`whk billing checkout`) is a page
//! the person opens signed in as the account's owner, which goes on to
//! Polar's checkout to pay with their own card (nothing is charged until they
//! do, so no approval is asked for), and `checkout-status` follows it.

use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::account::{ApprovalOptions, ask};
use crate::cli::output::{bold, dim, green, sanitize};
use crate::error::CliError;
use crate::util::format::format_timestamp;

/// A billing change, as the subcommands name it.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Plan {
        plan: String,
        interval: String,
    },
    KeepPlan,
    Seats(u32),
    MonthlyBlocks {
        blocks: u32,
        resource: String,
    },
    BuyBlocks {
        blocks: u32,
        resource: String,
    },
    Overage {
        enabled: bool,
        max_blocks: Option<u32>,
        resource: String,
    },
    Cancel,
    Resume,
}

const TEAM_PLANS: [&str; 2] = ["team", "team_business"];

/// The route (under the account's or the team's billing) and body a change
/// goes to; `None` for a body means DELETE.
fn request_for(change: &Change, team: bool) -> Result<(&'static str, Option<Value>)> {
    Ok(match change {
        Change::Plan { plan, interval } => {
            if TEAM_PLANS.contains(&plan.as_str()) != team {
                return Err(CliError::Usage(if team {
                    "a team's plan is team or team_business".into()
                } else {
                    "team and team_business are a team's plans: pass --team".into()
                })
                .into());
            }
            let route = if team { "plan" } else { "change-plan" };
            (route, Some(json!({ "plan": plan, "interval": interval })))
        }
        Change::KeepPlan if team => ("plan", Some(json!({ "action": "keep" }))),
        Change::KeepPlan => ("change-plan", None),
        Change::Seats(seats) => {
            if !team {
                return Err(CliError::Usage("seats belong to a team: pass --team".into()).into());
            }
            ("seats", Some(json!({ "seats": seats })))
        }
        Change::MonthlyBlocks { blocks, resource } => (
            "capacity",
            Some(json!({ "action": "set_monthly_blocks", "blocks": blocks, "resource": resource })),
        ),
        Change::BuyBlocks { blocks, resource } => (
            "capacity",
            Some(json!({ "action": "buy_blocks", "blocks": blocks, "resource": resource })),
        ),
        Change::Overage {
            enabled,
            max_blocks,
            resource,
        } => {
            let mut body =
                json!({ "action": "set_overage", "enabled": enabled, "resource": resource });
            if let Some(max) = max_blocks {
                body["maxBlocks"] = json!(max);
            }
            ("capacity", Some(body))
        }
        Change::Cancel => ("cancel", Some(json!({}))),
        Change::Resume => ("resubscribe", Some(json!({}))),
    })
}

/// Asks for a billing change. With an API key or agent token, prints the
/// quote's approval link and code and waits for the owner's answer; a
/// browser session's change is made at once.
pub async fn change(
    client: &ApiClient,
    team: Option<&str>,
    change: Change,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let team = match team {
        Some(needle) => Some(crate::cli::teams::find_team(client, needle).await?),
        None => None,
    };
    let (route, body) = request_for(&change, team.is_some())?;
    let team_id = team.as_ref().map(|t| t.id.as_str());
    let answer = client.billing_change(team_id, route, body.as_ref()).await?;
    let answer = if answer.is_null() {
        json!({ "executed": true })
    } else {
        answer
    };
    ask(client, answer, opts, json, |done| {
        if let Some(url) = done.get("url").and_then(Value::as_str) {
            println!("  Pay at the checkout to finish: {}", bold(url));
        } else {
            println!("  {} Done.", green("✓"));
        }
    })
    .await
}

/// The error an approved billing change that was not (or maybe not) made
/// reports: `executed: false` with `quote_changed` is quote_changed, with
/// any other code billing_refused carrying the server's code, and
/// `executed: null` is outcome_unknown. None when it was made.
pub(crate) fn outcome_error(result: &Value) -> Option<CliError> {
    let reason = || {
        result
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Nothing was changed.")
            .to_string()
    };
    match result.get("executed")? {
        Value::Bool(false) => {
            let code = result
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("refused");
            Some(if code == "quote_changed" {
                CliError::QuoteChanged(reason())
            } else {
                CliError::BillingRefused {
                    code: code.to_string(),
                    reason: reason(),
                }
            })
        }
        Value::Null => Some(CliError::OutcomeUnknown(reason())),
        _ => None,
    }
}

/// What an approved billing change did (one that was not made is reported
/// as an error instead, outcome_error).
pub(crate) fn print_outcome(result: &Value, executed: bool) {
    if !executed {
        return;
    }
    let change = sanitize(result.get("change").and_then(Value::as_str).unwrap_or(""));
    println!("\n  {} {change}", green("Approved."));
    match result.get("applied").and_then(Value::as_str) {
        // Only the owner's browser gets the checkout; nothing is bought yet.
        Some("checkout") => println!(
            "  {}",
            dim(
                "A Polar checkout was opened for the owner; nothing is bought until it is paid there."
            )
        ),
        Some("renewal") => println!("  {}", dim("It takes effect at the renewal.")),
        _ => println!("  {}", dim("It took effect at once.")),
    }
    if let Some(seats) = result.get("seatReductionLost").and_then(Value::as_u64) {
        println!(
            "  {}",
            dim(&format!(
                "The reduction to {seats} seats was dropped with the plan change; set the seats again."
            ))
        );
    }
}

// Tests poll quickly; the server allows two polls a second.
const POLL_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(20)
} else {
    Duration::from_secs(3)
};

/// What `whk billing checkout` was asked to buy.
pub struct CheckoutArgs {
    pub kind: String,
    pub plan: Option<String>,
    pub interval: Option<String>,
    pub seats: Option<u32>,
    pub blocks: Option<u32>,
    pub resource: Option<String>,
    pub team: Option<String>,
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The request body: the kind as the API names it, and only what was given.
async fn checkout_body(client: &ApiClient, args: CheckoutArgs) -> Result<Value> {
    let mut body = json!({ "kind": args.kind.replace('-', "_") });
    if let Some(plan) = args.plan {
        body["plan"] = json!(plan);
    }
    if let Some(interval) = args.interval {
        body["interval"] = json!(interval);
    }
    if let Some(seats) = args.seats {
        body["seats"] = json!(seats);
    }
    if let Some(blocks) = args.blocks {
        body["blocks"] = json!(blocks);
    }
    if let Some(resource) = args.resource {
        body["resource"] = json!(resource);
    }
    if let Some(team) = args.team {
        let id = if is_uuid(&team) {
            team
        } else {
            let teams = client.list_teams().await?;
            crate::cli::teams::resolve_team(&teams.value, &team)?
                .id
                .clone()
        };
        body["teamId"] = json!(id);
    }
    Ok(body)
}

/// `whk billing checkout`: makes the link and prints it for the person;
/// with `wait` (a timeout), waits until they pay.
pub async fn checkout(
    client: &ApiClient,
    args: CheckoutArgs,
    wait: Option<&str>,
    json: bool,
) -> Result<()> {
    let deadline = wait.map(deadline).transpose()?;
    let body = checkout_body(client, args).await?;
    let answer = client.create_checkout(&body).await?;
    let link = &answer.raw["checkout"];
    let id = link["id"].as_str().unwrap_or_default().to_string();
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.raw)?);
    } else {
        println!("\n  {}", sanitize(link["summary"].as_str().unwrap_or("")));
        println!("\n  Hand the person this link to pay with their own card:\n");
        println!("    {}\n", bold(link["url"].as_str().unwrap_or("")));
        let expires = date(&link["expiresAt"]).unwrap_or_default();
        println!("  They open it signed in as the account's owner, and nothing is charged");
        println!("  until they pay on Polar's page. It expires {expires}.");
        if deadline.is_none() {
            println!(
                "  Follow it with {}.",
                bold(&format!("whk billing checkout-status {id} --wait"))
            );
        }
    }
    match deadline {
        Some(deadline) => {
            if !json {
                println!("\n  Waiting for the payment...");
            }
            wait_until_paid(client, &id, deadline, json).await
        }
        None => Ok(()),
    }
}

/// `whk billing checkout-status`: where a link stands; with `wait`, waits
/// until it is paid (checkout_expired if it expires first, checkout_superseded
/// if its payment went back as a duplicate plan).
pub async fn checkout_status(
    client: &ApiClient,
    id: &str,
    wait: Option<&str>,
    json: bool,
) -> Result<()> {
    if let Some(timeout) = wait {
        return wait_until_paid(client, id, deadline(timeout)?, json).await;
    }
    let answer = client.get_checkout(id).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.raw)?);
    } else {
        print_status(&answer.raw["checkout"]);
    }
    Ok(())
}

/// `whk billing checkout-cancel`: the link can no longer be paid.
pub async fn checkout_cancel(client: &ApiClient, id: &str, json: bool) -> Result<()> {
    let answer = client.cancel_checkout(id).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.raw)?);
    } else {
        println!("{}", cancelled_line(&answer.raw["checkout"]));
    }
    Ok(())
}

fn cancelled_line(link: &Value) -> String {
    format!(
        "  Cancelled: {} The link can no longer be paid.",
        sanitize(link["summary"].as_str().unwrap_or(""))
    )
}

fn deadline(timeout: &str) -> Result<Instant> {
    let ms = crate::cli::wait::parse_timeout(timeout)?;
    Ok(Instant::now() + Duration::from_millis(ms.max(0) as u64))
}

async fn wait_until_paid(
    client: &ApiClient,
    id: &str,
    deadline: Instant,
    json: bool,
) -> Result<()> {
    use anyhow::Context;
    loop {
        let answer = client.get_checkout(id).await.with_context(|| {
            format!("could not check checkout link {id}; run `whk billing checkout-status {id} --wait` to try again")
        })?;
        let link = &answer.raw["checkout"];
        match link["status"].as_str() {
            Some("paid") => {
                if json {
                    println!("{}", serde_json::to_string_pretty(&answer.raw)?);
                } else {
                    print_status(link);
                }
                return Ok(());
            }
            Some("expired") => return Err(CliError::CheckoutExpired.into()),
            Some("superseded") => return Err(CliError::CheckoutSuperseded.into()),
            _ => {}
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(CliError::Timeout(format!(
                "Not paid yet. Run `whk billing checkout-status {id} --wait` to keep waiting."
            ))
            .into());
        }
        tokio::time::sleep(POLL_EVERY.min(left)).await;
    }
}

fn print_status(link: &Value) {
    let summary = sanitize(link["summary"].as_str().unwrap_or(""));
    match link["status"].as_str() {
        Some("paid") => {
            let when = date(&link["paidAt"]).unwrap_or_default();
            println!("  {} {summary}", green("Paid."));
            println!(
                "  {}",
                dim(&format!(
                    "Paid {when}; it is applied to the account within a minute."
                ))
            );
            if link["matches"] == Value::Bool(false) {
                println!(
                    "  What was bought differs from what the link asked for ({}); check `whk billing`.",
                    bought(&link["bought"])
                );
            }
        }
        Some("superseded") => {
            println!("  Refunded: {summary}");
            println!(
                "  {}",
                dim(
                    "By the time it was paid, the account already had what it buys (or what it added to had ended), so it was undone and the payment goes back; monthly blocks bought twice stay as one-time blocks."
                )
            );
        }
        Some("expired") => {
            println!("  Expired: {summary}");
            println!(
                "  {}",
                dim("Make a new link with `whk billing checkout` if the person still wants it.")
            );
        }
        _ => {
            println!("  Open: {summary}");
            println!("\n    {}\n", bold(link["url"].as_str().unwrap_or("")));
            let expires = date(&link["expiresAt"]).unwrap_or_default();
            println!(
                "  {}",
                dim(&format!("Not paid yet; the link expires {expires}."))
            );
        }
    }
}

/// What a paid link's order or subscription holds, in a few words.
fn bought(value: &Value) -> String {
    if let Some(seats) = value["seats"].as_u64() {
        return format!("{seats} seats");
    }
    if let Some(units) = value["units"].as_u64() {
        return format!("{units} units");
    }
    "another product".into()
}

pub async fn show(client: &ApiClient, json: bool) -> Result<()> {
    let billing = client.get_billing().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&billing.json())?);
        return Ok(());
    }
    for line in summary_lines(&billing.value) {
        println!("{line}");
    }
    Ok(())
}

fn date(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| format_timestamp(t.timestamp_millis()))
}

fn plan_name(plan: &str) -> String {
    match plan {
        "free" => "Free".into(),
        "pro" => "Pro".into(),
        "business" => "Business".into(),
        "team" => "Teams".into(),
        "team_business" => "Team Business".into(),
        other => other.to_string(),
    }
}

fn interval_name(v: &Value) -> Option<&'static str> {
    match v.as_str()? {
        "month" => Some("monthly"),
        "year" => Some("annual"),
        _ => None,
    }
}

/// One line per add-on resource that has anything going on.
fn addon_lines(addons: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for resource in ["requests", "pages", "domains"] {
        let Some(state) = addons.get(resource) else {
            continue;
        };
        let mut parts = Vec::new();
        if let Some(units) = state.pointer("/blocks/units").and_then(Value::as_u64)
            && units > 0
        {
            parts.push(format!("{units} monthly"));
        }
        if let Some(credit) = state.get("creditRequests").and_then(Value::as_u64)
            && credit > 0
        {
            parts.push(format!("{credit} one-time left"));
        }
        if state
            .pointer("/overage/subscribed")
            .and_then(Value::as_bool)
            == Some(true)
        {
            let active = state.pointer("/overage/active").and_then(Value::as_bool) == Some(true);
            parts.push(
                if active {
                    "overage on"
                } else {
                    "overage paused"
                }
                .into(),
            );
        }
        if !parts.is_empty() {
            out.push(format!("    {resource}: {}", parts.join(", ")));
        }
    }
    out
}

fn subscription_line(name: &str, sub: &Value) -> String {
    let mut line = name.to_string();
    if let Some(interval) = interval_name(&sub["interval"]) {
        line.push_str(&format!(" ({interval})"));
    }
    if let Some(status) = sub["status"].as_str() {
        line.push_str(&format!(", {}", status.replace('_', " ")));
    }
    line
}

fn summary_lines(b: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let plan = plan_name(b["plan"].as_str().unwrap_or("free"));
    match b.get("subscription").filter(|s| !s.is_null()) {
        Some(sub) => {
            out.push(format!("  Plan: {}", bold(&subscription_line(&plan, sub))));
            if let Some(when) = date(&sub["renewsAt"]) {
                let verb = if sub["cancelAtPeriodEnd"].as_bool() == Some(true) {
                    "Ends"
                } else {
                    "Renews"
                };
                out.push(format!("  {verb} {when}"));
            }
            if let Some(change) = sub.get("pendingChange").filter(|c| !c.is_null()) {
                let to = plan_name(change["plan"].as_str().unwrap_or(""));
                let interval = interval_name(&change["interval"])
                    .map(|i| format!(" ({i})"))
                    .unwrap_or_default();
                out.push(format!("  Changes to {to}{interval} at the renewal"));
            }
        }
        None => out.push(format!("  Plan: {}", bold(&plan))),
    }
    let addons = addon_lines(&b["addons"]);
    if !addons.is_empty() {
        out.push("  Add-ons:".into());
        out.extend(addons);
    }

    if let Some(teams) = b["teams"].as_array()
        && !teams.is_empty()
    {
        out.push(String::new());
        out.push("  Teams:".into());
        for team in teams {
            let name = sanitize(team["name"].as_str().unwrap_or("?"));
            let role = team["role"].as_str().unwrap_or("member");
            if team["subscriptionStatus"].is_null() {
                out.push(format!("    {} ({role}): not subscribed", bold(&name)));
                continue;
            }
            let kind = if team["business"].as_bool() == Some(true) {
                "Team Business"
            } else {
                "Teams"
            };
            let mut line = format!(
                "    {} ({role}): {kind}, {} seats",
                bold(&name),
                team["seats"].as_u64().unwrap_or(0)
            );
            if let Some(pending) = team["pendingSeats"].as_u64() {
                line.push_str(&format!(" ({pending} from the renewal)"));
            }
            if let Some(status) = team["subscriptionStatus"].as_str() {
                line.push_str(&format!(", {}", status.replace('_', " ")));
            }
            out.push(line);
            if let Some(when) = date(&team["billingPeriodEnd"])
                .or_else(|| team["billingPeriodEnd"].as_i64().map(format_timestamp))
            {
                let verb = if team["cancelAtPeriodEnd"].as_bool() == Some(true) {
                    "ends"
                } else {
                    "renews"
                };
                out.push(format!("      {verb} {when}"));
            }
            for addon in addon_lines(&team["addons"]) {
                out.push(format!("  {addon}"));
            }
        }
    }
    out.push(String::new());
    out.push(format!(
        "  {}",
        dim("Change it with `whk billing plan|seats|blocks|overage|cancel ...` (the owner approves each change), or hand the person a link to pay from `whk billing checkout`.")
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_cancelled_link_says_what_it_no_longer_buys() {
        let line = cancelled_line(&json!({
            "status": "expired",
            "summary": "The Pro plan, billed monthly.\u{1b}[2J",
        }));
        assert_eq!(
            line,
            "  Cancelled: The Pro plan, billed monthly.[2J The link can no longer be paid."
        );
    }

    #[test]
    fn a_paid_plan_with_add_ons_and_a_team() {
        let lines = summary_lines(&json!({
            "plan": "pro",
            "subscription": {
                "status": "active", "interval": "month",
                "renewsAt": "2026-12-10T00:00:00.000Z", "cancelAtPeriodEnd": false,
                "pendingChange": { "plan": "business", "interval": "year" }
            },
            "addons": {
                "requests": { "blocks": { "units": 2 }, "creditRequests": 25000,
                              "overage": { "subscribed": true, "active": true } },
                "pages": { "blocks": null, "creditRequests": 0, "overage": { "subscribed": false } }
            },
            "teams": [{
                "name": "Acme", "role": "owner", "subscriptionStatus": "active", "business": true,
                "seats": 5, "pendingSeats": 3, "billingPeriodEnd": 1_796_860_800_000_i64,
                "cancelAtPeriodEnd": false, "addons": {}
            }]
        }))
        .join("\n");
        assert!(lines.contains("Pro (monthly), active"));
        assert!(lines.contains("Renews"));
        assert!(lines.contains("Changes to Business (annual) at the renewal"));
        assert!(lines.contains("requests: 2 monthly, 25000 one-time left, overage on"));
        assert!(!lines.contains("pages:"));
        assert!(lines.contains("Team Business, 5 seats (3 from the renewal), active"));
    }

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    fn link(status: &str) -> Value {
        json!({ "checkout": {
            "id": ID, "status": status, "kind": "plan",
            "summary": "The Pro plan, billed monthly.",
            "item": { "kind": "plan", "plan": "pro", "interval": "month" },
            "teamId": null,
            "url": if status == "open" { json!(format!("https://webhooks.cc/checkout/{ID}")) } else { Value::Null },
            "createdAt": "2026-11-14T12:00:00.000Z", "expiresAt": "2026-11-14T13:00:00.000Z",
            "paidAt": null
        }})
    }

    /// A fake API: POST answers an open link and records the body; GET
    /// answers the statuses in turn.
    async fn server(
        statuses: Vec<&'static str>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Option<Value>>>) {
        use axum::routing::{get, post};
        use std::sync::{Arc, Mutex};
        let asked: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let polls = Arc::new(Mutex::new(0usize));
        let recorded = asked.clone();
        let app = axum::Router::new()
            .route(
                "/api/billing/checkouts",
                post(move |axum::Json(body): axum::Json<Value>| {
                    let recorded = recorded.clone();
                    async move {
                        *recorded.lock().unwrap() = Some(body);
                        (axum::http::StatusCode::CREATED, axum::Json(link("open")))
                    }
                }),
            )
            .route(
                "/api/billing/checkouts/{id}",
                get(move || {
                    let polls = polls.clone();
                    let statuses = statuses.clone();
                    async move {
                        let mut n = polls.lock().unwrap();
                        let status = statuses[(*n).min(statuses.len() - 1)];
                        *n += 1;
                        axum::Json(link(status))
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

    fn args(kind: &str) -> CheckoutArgs {
        CheckoutArgs {
            kind: kind.into(),
            plan: None,
            interval: None,
            seats: None,
            blocks: None,
            resource: None,
            team: None,
        }
    }

    #[tokio::test]
    async fn makes_a_link_then_waits_until_it_is_paid() {
        let (base, asked) = server(vec!["open", "paid"]).await;
        let mut item = args("team-plan");
        item.seats = Some(3);
        item.team = Some("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into());
        checkout(&client(&base), item, Some("1m"), true)
            .await
            .unwrap();
        assert_eq!(
            asked.lock().unwrap().clone().unwrap(),
            json!({ "kind": "team_plan", "seats": 3, "teamId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })
        );
    }

    #[tokio::test]
    async fn an_expired_link_is_checkout_expired() {
        let (base, _) = server(vec!["expired"]).await;
        let error = checkout_status(&client(&base), ID, Some("1m"), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("checkout_expired", 8));
        // Without --wait it only reports.
        checkout_status(&client(&base), ID, None, true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_superseded_link_is_checkout_superseded() {
        let (base, _) = server(vec!["superseded"]).await;
        let error = checkout_status(&client(&base), ID, Some("1m"), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("checkout_superseded", 8));
    }

    #[test]
    fn says_what_was_bought() {
        assert_eq!(bought(&json!({ "seats": 5, "units": null })), "5 seats");
        assert_eq!(bought(&json!({ "seats": null, "units": 3 })), "3 units");
        assert_eq!(bought(&Value::Null), "another product");
    }

    #[tokio::test]
    async fn waiting_past_the_timeout_says_how_to_resume() {
        let (base, _) = server(vec!["open"]).await;
        let error = checkout_status(&client(&base), ID, Some("1s"), true)
            .await
            .unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "timeout");
        assert!(format!("{error:#}").contains(&format!("whk billing checkout-status {ID} --wait")));
    }

    #[test]
    fn changes_go_to_the_account_or_the_team() {
        let plan = Change::Plan {
            plan: "business".into(),
            interval: "month".into(),
        };
        assert_eq!(
            request_for(&plan, false).unwrap(),
            (
                "change-plan",
                Some(json!({ "plan": "business", "interval": "month" }))
            )
        );
        assert!(
            request_for(&plan, true).is_err(),
            "Business is not a team plan"
        );
        assert_eq!(
            request_for(&Change::KeepPlan, false).unwrap(),
            ("change-plan", None)
        );
        assert_eq!(
            request_for(&Change::KeepPlan, true).unwrap(),
            ("plan", Some(json!({ "action": "keep" })))
        );
        assert!(
            request_for(&Change::Seats(4), false).is_err(),
            "seats need a team"
        );
        assert_eq!(
            request_for(
                &Change::Overage {
                    enabled: true,
                    max_blocks: Some(4),
                    resource: "pages".into()
                },
                false
            )
            .unwrap()
            .1,
            Some(
                json!({ "action": "set_overage", "enabled": true, "resource": "pages", "maxBlocks": 4 })
            )
        );
    }

    #[test]
    fn free_without_teams() {
        let lines = summary_lines(&json!({
            "plan": "free", "subscription": null, "addons": {}, "teams": []
        }))
        .join("\n");
        assert!(lines.contains("Plan:"));
        assert!(lines.contains("Free"));
        assert!(!lines.contains("Teams:"));
    }

    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    const TEAM: &str = "4f8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

    fn opts() -> ApprovalOptions {
        ApprovalOptions {
            remote: true,
            no_browser: true,
            no_wait: false,
            timeout: "1m".into(),
        }
    }

    /// A team route, its seats asking for approval, and an approval whose
    /// result is `result`.
    fn app(result: Value, seen: std::sync::Arc<std::sync::Mutex<Option<Value>>>) -> axum::Router {
        let approval = json!({
            "id": "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f", "status": "pending",
            "action": "billing.change",
            "summary": "Change the team \"Payments\" from 3 to 5 seats. $16.00 is charged now.",
            "code": "ABCD-EFGH", "url": "https://webhooks.cc/approve?code=ABCD-EFGH",
            "expiresAt": "2026-11-14T12:15:00.000Z",
        });
        let pending = approval.clone();
        let mut completed = approval;
        completed["status"] = json!("completed");
        axum::Router::new()
            .route(
                "/api/teams",
                axum::routing::get(|| async {
                    axum::Json(json!([{
                        "id": TEAM, "name": "Payments", "role": "owner", "seats": 3,
                        "requestsUsed": 0, "requestLimit": 300000, "periodEnd": null,
                        "suspended": false
                    }]))
                }),
            )
            .route(
                "/api/teams/{id}/billing/seats",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let pending = pending.clone();
                    async move {
                        *seen.lock().unwrap() = Some(body);
                        (
                            axum::http::StatusCode::ACCEPTED,
                            axum::Json(json!({ "approval": pending })),
                        )
                    }
                }),
            )
            .route(
                "/api/approvals/{id}",
                axum::routing::get(move || {
                    let body = json!({ "approval": completed.clone(), "result": result.clone() });
                    async move { axum::Json(body) }
                }),
            )
    }

    #[tokio::test]
    async fn a_seat_change_asks_the_owner_then_reads_what_was_done() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let base = serve(app(
            json!({ "executed": true, "applied": "now", "change": "Change the team." }),
            seen.clone(),
        ))
        .await;
        change(
            &client(&base),
            Some("payments"),
            Change::Seats(5),
            opts(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(seen.lock().unwrap().clone(), Some(json!({ "seats": 5 })));
    }

    #[tokio::test]
    async fn a_change_refused_on_a_fresh_quote_is_quote_changed() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let base = serve(app(
            json!({
                "executed": false, "code": "quote_changed",
                "reason": "Nothing was changed: the price changed."
            }),
            seen,
        ))
        .await;
        let error = change(&client(&base), Some(TEAM), Change::Seats(5), opts(), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("quote_changed", 8));
    }

    #[tokio::test]
    async fn another_refusal_keeps_the_servers_code() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let base = serve(app(
            json!({
                "executed": false, "code": "payment_failed",
                "reason": "Nothing was changed: your payment method was declined."
            }),
            seen,
        ))
        .await;
        let error = change(&client(&base), Some(TEAM), Change::Seats(5), opts(), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("billing_refused", 1));
        assert_eq!(c.reason.as_deref(), Some("payment_failed"));
        assert!(error.to_string().contains("declined"));
    }

    #[tokio::test]
    async fn an_unknown_outcome_says_to_check_billing() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None));
        let base = serve(app(
            json!({
                "executed": null, "code": "outcome_unknown",
                "reason": "The change may or may not have been made. Check billing before asking again."
            }),
            seen,
        ))
        .await;
        let error = change(&client(&base), Some(TEAM), Change::Seats(5), opts(), true)
            .await
            .unwrap_err();
        let c = crate::error::classify(&error);
        assert_eq!((c.code, c.exit), ("outcome_unknown", 1));
    }

    #[test]
    fn a_made_change_is_no_error() {
        assert!(outcome_error(&json!({ "executed": true, "applied": "now" })).is_none());
        assert!(outcome_error(&json!({ "executed": true, "applied": "checkout" })).is_none());
    }
}
