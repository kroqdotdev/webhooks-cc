//! `whk billing`: what the account pays for, read only, and checkout
//! links. Paying stays with the person: `whk billing checkout` makes a
//! Polar checkout for them to pay with their own card (nothing is charged
//! until they do, so no approval is asked for), and `checkout-status`
//! follows it. Changing or cancelling a plan takes the person in a browser
//! (the dashboard's Plan page).

use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize};
use crate::error::CliError;
use crate::util::format::format_timestamp;

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
        println!("  Nothing is charged until they pay there. It expires {expires}.");
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
/// until it is paid (checkout_expired if it expires first).
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
        dim("To buy, hand the person a link from `whk billing checkout`. Other plan, seat and add-on changes are made in the browser, under Account > Plan.")
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            "url": if status == "open" { json!("https://polar.sh/checkout/polar_c_x") } else { Value::Null },
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
    async fn waiting_past_the_timeout_says_how_to_resume() {
        let (base, _) = server(vec!["open"]).await;
        let error = checkout_status(&client(&base), ID, Some("1s"), true)
            .await
            .unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "timeout");
        assert!(format!("{error:#}").contains(&format!("whk billing checkout-status {ID} --wait")));
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
}
