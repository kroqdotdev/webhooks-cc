//! `whk billing`: what the account pays for, read only. Changing a plan,
//! seats or add-ons takes the person in a browser (the dashboard's Plan page).

use anyhow::Result;
use serde_json::Value;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, sanitize};
use crate::util::format::format_timestamp;

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
        dim("Plan, seat and add-on changes are made in the browser, under Account > Plan.")
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
