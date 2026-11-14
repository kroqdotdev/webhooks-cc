//! `whk alerts`: an endpoint's alerts. When one opens (emails missing a
//! field, a silence, a delivery that failed for good), who hears of it (the
//! owner by email, the endpoint's destinations), and the recent alerts.
//! Owner only.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, red, sanitize_line};
use crate::error::CliError;
use crate::util::format::format_timestamp;

/// A threshold that can be switched off: a number in its range, or `off`
/// (the API's null).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Threshold {
    Off,
    At(u32),
}

impl Threshold {
    fn json(self) -> Value {
        match self {
            Threshold::Off => Value::Null,
            Threshold::At(n) => json!(n),
        }
    }
}

fn threshold(value: &str, max: u32) -> Result<Threshold, String> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("off") {
        return Ok(Threshold::Off);
    }
    match value.parse::<u32>() {
        Ok(n) if (1..=max).contains(&n) => Ok(Threshold::At(n)),
        _ => Err(format!("a whole number from 1 to {max}, or off")),
    }
}

fn up_to_100(value: &str) -> Result<Threshold, String> {
    threshold(value, 100)
}

fn up_to_720(value: &str) -> Result<Threshold, String> {
    threshold(value, 720)
}

/// The settings, as flags. Only those given are sent; the rest stay as saved.
#[derive(clap::Args, Debug, Default, Clone)]
pub struct AlertFields {
    /// Switch the endpoint's alerts on or off
    #[arg(long, value_name = "true|false")]
    pub enabled: Option<bool>,

    /// Open an alert when this many emails in a row miss a required field, 1 to 100, or off
    #[arg(long, value_name = "N|off", value_parser = up_to_100)]
    pub field_failures: Option<Threshold>,

    /// Open an alert when this percent of the last 20 emails missed a required field, 1 to 100, or off
    #[arg(long, value_name = "PERCENT|off", value_parser = up_to_100)]
    pub field_failure_share: Option<Threshold>,

    /// A field that must be found (repeatable; replaces the list)
    #[arg(long = "required-field", value_name = "NAME")]
    pub required_fields: Vec<String>,

    /// Require every email field (the default), instead of a list
    #[arg(long, conflicts_with = "required_fields")]
    pub all_fields: bool,

    /// Open an alert after this many hours without an email, 1 to 720, or off
    #[arg(long, value_name = "HOURS|off", value_parser = up_to_720)]
    pub silence_hours: Option<Threshold>,

    /// Open an alert when a delivery to a destination fails for good
    #[arg(long, value_name = "true|false")]
    pub destination_failures: Option<bool>,

    /// Email the endpoint's owner when an alert opens and when it resolves
    #[arg(long, value_name = "true|false")]
    pub notify_email: Option<bool>,

    /// A destination of the endpoint that also gets alerts, as alert.opened and alert.resolved events (repeatable; replaces the list)
    #[arg(long = "notify-destination", value_name = "ID")]
    pub notify_destinations: Vec<String>,

    /// No destination gets alerts
    #[arg(long, conflicts_with = "notify_destinations")]
    pub no_notify_destinations: bool,
}

/// The PUT body for the flags given; empty when none were.
pub fn settings_body(fields: &AlertFields) -> Map<String, Value> {
    let mut body = Map::new();
    for (key, value) in [
        ("enabled", fields.enabled),
        ("destinationFailures", fields.destination_failures),
        ("notifyEmail", fields.notify_email),
    ] {
        if let Some(value) = value {
            body.insert(key.into(), json!(value));
        }
    }
    for (key, value) in [
        ("fieldFailures", fields.field_failures),
        ("fieldFailureShare", fields.field_failure_share),
        ("silenceHours", fields.silence_hours),
    ] {
        if let Some(value) = value {
            body.insert(key.into(), value.json());
        }
    }
    if fields.all_fields {
        body.insert("requiredFields".into(), Value::Null);
    } else if !fields.required_fields.is_empty() {
        let names: Vec<&str> = fields.required_fields.iter().map(|n| n.trim()).collect();
        body.insert("requiredFields".into(), json!(names));
    }
    if fields.no_notify_destinations {
        body.insert("notifyDestinationIds".into(), json!([]));
    } else if !fields.notify_destinations.is_empty() {
        let ids: Vec<&str> = fields
            .notify_destinations
            .iter()
            .map(|n| n.trim())
            .collect();
        body.insert("notifyDestinationIds".into(), json!(ids));
    }
    body
}

fn print_json(answer: &crate::api::client::Fetched<Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&answer.json())?);
    Ok(())
}

fn flag(settings: &Value, field: &str) -> bool {
    settings.get(field).and_then(Value::as_bool) == Some(true)
}

fn number(settings: &Value, field: &str) -> Option<u64> {
    settings.get(field).and_then(Value::as_u64)
}

/// The settings, a line each.
fn settings_lines(settings: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = |label: &str, value: String| {
        out.push(format!("  {} {value}", dim(&format!("{label:<14}"))))
    };
    line(
        "Alerts",
        if flag(settings, "enabled") {
            green("on")
        } else {
            "off".into()
        },
    );
    line(
        "Missing field",
        match number(settings, "fieldFailures") {
            Some(n) => format!("after {n} email{} in a row", if n == 1 { "" } else { "s" }),
            None => "off".into(),
        },
    );
    line(
        "Missing share",
        match number(settings, "fieldFailureShare") {
            Some(n) => format!("{n}% of the last 20 emails"),
            None => "off".into(),
        },
    );
    let required = match settings.get("requiredFields").and_then(Value::as_array) {
        Some(names) if !names.is_empty() => names
            .iter()
            .filter_map(Value::as_str)
            .map(sanitize_line)
            .collect::<Vec<_>>()
            .join(", "),
        Some(_) => "none".into(),
        None => "every email field".into(),
    };
    line("Required", required);
    line(
        "Silence",
        match number(settings, "silenceHours") {
            Some(n) => format!(
                "after {n} hour{} without an email",
                if n == 1 { "" } else { "s" }
            ),
            None => "off".into(),
        },
    );
    line(
        "Deliveries",
        if flag(settings, "destinationFailures") {
            "when a delivery fails for good".into()
        } else {
            "off".into()
        },
    );
    let mut who = Vec::new();
    if flag(settings, "notifyEmail") {
        who.push("the owner by email".to_string());
    }
    let destinations: Vec<String> = settings
        .get("notifyDestinationIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(sanitize_line)
        .collect();
    if !destinations.is_empty() {
        who.push(format!("destinations {}", destinations.join(", ")));
    }
    line(
        "Tells",
        if who.is_empty() {
            "nobody".into()
        } else {
            who.join("; ")
        },
    );
    out
}

fn event_kind(kind: &str) -> &'static str {
    match kind {
        "fields" => "missing fields",
        "silence" => "silence",
        "destination" => "failed deliveries",
        _ => "alert",
    }
}

/// The recent alerts, open ones first as the server sends them.
fn event_lines(events: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for event in events {
        let opened = event.get("openedAt").and_then(Value::as_i64).unwrap_or(0);
        let state = match event.get("resolvedAt").and_then(Value::as_i64) {
            Some(resolved) => format!("resolved {}", format_timestamp(resolved)),
            None => red("open"),
        };
        let subject = event
            .get("subject")
            .and_then(Value::as_str)
            .map(|s| format!(" {}", dim(&sanitize_line(s))))
            .unwrap_or_default();
        out.push(format!(
            "  {} {}{subject}  {} {state}",
            bold(event_kind(
                event.get("kind").and_then(Value::as_str).unwrap_or("")
            )),
            dim(&format!("opened {}", format_timestamp(opened))),
            dim("·"),
        ));
    }
    out
}

pub async fn get(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let answer = client.get_alerts(slug).await?;
    if json {
        return print_json(&answer);
    }
    let settings = answer.value.get("settings").cloned().unwrap_or(Value::Null);
    for line in settings_lines(&settings) {
        println!("{line}");
    }
    let events = answer
        .value
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    println!();
    if events.is_empty() {
        println!("  {}", dim("No alerts yet."));
    } else {
        println!("  {}", bold("Recent alerts"));
        for line in event_lines(&events) {
            println!("{line}");
        }
    }
    Ok(())
}

pub async fn set(client: &ApiClient, slug: &str, fields: &AlertFields, json: bool) -> Result<()> {
    let body = settings_body(fields);
    if body.is_empty() {
        return Err(CliError::Usage(
            "Nothing to change: pass at least one setting (see `whk alerts set --help`).".into(),
        )
        .into());
    }
    let answer = client.update_alerts(slug, &Value::Object(body)).await?;
    if json {
        return print_json(&answer);
    }
    println!(
        "{} Saved the alerts of {}",
        green("✓"),
        bold(&sanitize_line(slug))
    );
    let settings = answer.value.get("settings").cloned().unwrap_or(Value::Null);
    for line in settings_lines(&settings) {
        println!("{line}");
    }
    // The server keeps only destinations that can take a notice.
    let asked = fields.notify_destinations.len();
    let kept = settings
        .get("notifyDestinationIds")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if asked > kept {
        println!(
            "  {}",
            dim(
                "Some destinations were left out: they are not this endpoint's, or are a spreadsheet or a file drop, which cannot take alerts."
            )
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;
    use clap::Parser;

    #[derive(Parser)]
    struct Args {
        #[command(flatten)]
        fields: AlertFields,
    }

    fn parse(args: &[&str]) -> Result<AlertFields, clap::Error> {
        let mut argv = vec!["test"];
        argv.extend_from_slice(args);
        Args::try_parse_from(argv).map(|a| a.fields)
    }

    #[test]
    fn only_the_flags_given_are_sent() {
        assert!(settings_body(&parse(&[]).unwrap()).is_empty());
        let body = settings_body(
            &parse(&[
                "--enabled",
                "true",
                "--field-failures",
                "3",
                "--silence-hours",
                "off",
                "--required-field",
                "order",
                "--required-field",
                " total ",
                "--notify-email",
                "false",
            ])
            .unwrap(),
        );
        assert_eq!(
            Value::Object(body),
            json!({
                "enabled": true,
                "fieldFailures": 3,
                "silenceHours": null,
                "requiredFields": ["order", "total"],
                "notifyEmail": false,
            })
        );
    }

    #[test]
    fn lists_can_be_reset() {
        let body = settings_body(&parse(&["--all-fields", "--no-notify-destinations"]).unwrap());
        assert_eq!(
            Value::Object(body),
            json!({ "requiredFields": null, "notifyDestinationIds": [] })
        );
        assert!(parse(&["--all-fields", "--required-field", "order"]).is_err());
        assert!(parse(&["--no-notify-destinations", "--notify-destination", "d1"]).is_err());
    }

    #[test]
    fn thresholds_keep_to_their_range() {
        assert!(parse(&["--field-failures", "0"]).is_err());
        assert!(parse(&["--field-failures", "101"]).is_err());
        assert!(parse(&["--field-failure-share", "100"]).is_ok());
        assert!(parse(&["--silence-hours", "720"]).is_ok());
        assert!(parse(&["--silence-hours", "721"]).is_err());
        assert!(parse(&["--silence-hours", "OFF"]).is_ok());
        assert!(parse(&["--silence-hours", "1.5"]).is_err());
    }

    #[test]
    fn shows_the_settings_in_words() {
        let lines = settings_lines(&json!({
            "enabled": true, "fieldFailures": 3, "fieldFailureShare": null,
            "requiredFields": null, "silenceHours": 24, "destinationFailures": true,
            "notifyEmail": true, "notifyDestinationIds": ["d1"]
        }))
        .join("\n");
        assert!(lines.contains("after 3 emails in a row"), "{lines}");
        assert!(lines.contains("every email field"), "{lines}");
        assert!(lines.contains("after 24 hours without an email"), "{lines}");
        assert!(
            lines.contains("the owner by email; destinations d1"),
            "{lines}"
        );
    }

    #[test]
    fn an_alert_subject_stays_on_one_line() {
        let lines = event_lines(&[json!({
            "id": "a1", "kind": "destination", "subject": "hook\n  fake line",
            "openedAt": 0, "resolvedAt": null, "details": {}
        })]);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("failed deliveries"));
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

    #[tokio::test]
    async fn set_puts_only_the_changed_settings() {
        let sent: std::sync::Arc<std::sync::Mutex<Option<Value>>> = Default::default();
        let seen = sent.clone();
        let app = axum::Router::new().route(
            "/api/endpoints/{slug}/alerts",
            axum::routing::put(
                move |axum::extract::Path(slug): axum::extract::Path<String>,
                      axum::Json(body): axum::Json<Value>| async move {
                    assert_eq!(slug, "acme");
                    *seen.lock().unwrap() = Some(body);
                    axum::Json(json!({ "settings": { "enabled": false } }))
                },
            ),
        );
        let base = serve(app).await;
        let fields = parse(&["--enabled", "false"]).unwrap();
        set(&client(&base), "acme", &fields, true).await.unwrap();
        assert_eq!(
            sent.lock().unwrap().clone(),
            Some(json!({ "enabled": false }))
        );
    }

    #[tokio::test]
    async fn an_empty_set_is_refused_before_any_call() {
        let error = set(
            &client("http://127.0.0.1:9"),
            "acme",
            &AlertFields::default(),
            true,
        )
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }
}
