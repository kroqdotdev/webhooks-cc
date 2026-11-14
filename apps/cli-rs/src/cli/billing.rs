//! `whk billing`: what the account pays for, and changes to it. A change
//! (a plan, seats, add-ons, cancelling or keeping the plan) asked with an API
//! key or agent token is quoted and waits for the account's owner to approve
//! it on a web page; approving makes it only while the quote still holds.

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

/// What an approved billing change did ("executed": false is reported as
/// the quote_changed error instead).
pub(crate) fn print_outcome(result: &Value, executed: bool) {
    if !executed {
        return;
    }
    let change = sanitize(result.get("change").and_then(Value::as_str).unwrap_or(""));
    println!("\n  {} {change}", green("Approved."));
    match result.get("applied").and_then(Value::as_str) {
        Some("checkout") => {
            let url = result
                .get("checkoutUrl")
                .and_then(Value::as_str)
                .unwrap_or("");
            println!(
                "  {}",
                dim("The owner was sent to a Polar checkout; it takes effect once paid.")
            );
            if !url.is_empty() {
                println!("    {}", bold(url));
            }
        }
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
        dim("Change it with `whk billing plan|seats|blocks|overage|cancel ...`: the owner approves each change.")
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

    fn client(base: &str) -> ApiClient {
        ApiClient::with_credentials(Some(base), Some(base), Some("whcc_test".into()), None).unwrap()
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
}
