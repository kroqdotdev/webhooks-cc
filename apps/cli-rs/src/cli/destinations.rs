//! `whk destinations`: where an endpoint's captures are forwarded. Listing,
//! adding, changing, ordering and removing destinations, a dry run of what
//! one would send, a test delivery, and its signing secret. Owner only.
//!
//! Secrets never come from a flag, where they would land in shell history:
//! a file drop's password or key is read from `WHK_DROP_SECRET` and a
//! Mailgun signing key from `WHK_MAILGUN_SIGNING_KEY`, else typed at the
//! terminal without being shown.

use std::io::IsTerminal;

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use crate::api::ApiClient;
use crate::cli::confirm::confirm;
use crate::cli::output::{bold, dim, green, red, sanitize};
use crate::error::CliError;
use crate::util::format::format_timestamp;

/// How a destination sends (the API's `format`).
pub const FORMATS: [&str; 11] = [
    "auto",
    "as_received",
    "json",
    "template",
    "chat",
    "postmark",
    "sendgrid",
    "mailgun",
    "cloudmailin",
    "sheets",
    "file_drop",
];

/// The fields a destination is made of, as flags. Only those given are sent,
/// so an update changes only them.
#[derive(clap::Args, Debug, Default, Clone)]
pub struct DestinationFields {
    /// Where deliveries go (http or https); a file drop has none, its server is in --config
    #[arg(long)]
    pub url: Option<String>,

    /// A name to tell it apart by ("" clears it)
    #[arg(long)]
    pub name: Option<String>,

    /// Switch it on or off
    #[arg(long, value_name = "true|false")]
    pub enabled: Option<bool>,

    /// Whether it takes HTTP requests
    #[arg(long, value_name = "true|false")]
    pub http: Option<bool>,

    /// Whether it takes emails
    #[arg(long, value_name = "true|false")]
    pub email: Option<bool>,

    /// How it sends (auto picks from the URL: chat for Slack and Discord, else as received, signed JSON for email)
    #[arg(long, value_parser = FORMATS)]
    pub format: Option<String>,

    /// Which captures it gets: {"logic", "conditions"} as JSON, @file, or null for all of them
    #[arg(long, value_name = "JSON")]
    pub filter: Option<String>,

    /// For --format template: the JSON body with {{ placeholders }}, @file, or null
    #[arg(long, value_name = "JSON")]
    pub body_template: Option<String>,

    /// For --format chat: the message text with {{ placeholders }}, or @file ("" sends the standard message)
    #[arg(long, value_name = "TEXT")]
    pub message_template: Option<String>,

    /// A header sent with every delivery (repeatable; replaces the whole set). NAME alone keeps that header's stored value
    #[arg(long = "header", value_name = "NAME:VALUE")]
    pub headers: Vec<String>,

    /// Remove every header
    #[arg(long, conflicts_with = "headers")]
    pub clear_headers: bool,

    /// Append the captured path to the URL (as received)
    #[arg(long, value_name = "true|false")]
    pub append_path: Option<bool>,

    /// How long failed deliveries are retried: 0 (one try), 3600 or 86400
    #[arg(long, value_name = "SECONDS", value_parser = parse_retry)]
    pub retry_seconds: Option<u32>,

    /// One delivery at a time, in capture order
    #[arg(long, value_name = "true|false")]
    pub keep_order: Option<bool>,

    /// A JSON body field holding the sender's own timestamp, such as created_at ("" clears it)
    #[arg(long, value_name = "FIELD")]
    pub sent_field: Option<String>,

    /// At most one delivery every N seconds, 0 to 3600; the rest are not sent
    #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u32).range(0..=3600))]
    pub throttle_seconds: Option<u32>,

    /// Wait N seconds after the capture before the first try, 0 to 3600
    #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u32).range(0..=3600))]
    pub delay_seconds: Option<u32>,

    /// How emails' stored attachments travel
    #[arg(long, value_parser = ["links", "inline", "none"])]
    pub attachments: Option<String>,

    /// For --format sheets or file_drop: the spreadsheet and columns, or where files go and what they hold, as JSON or @file
    #[arg(long, value_name = "JSON")]
    pub config: Option<String>,
}

/// Secrets a destination keeps, which are never taken from a flag.
#[derive(clap::Args, Debug, Default, Clone)]
pub struct DestinationSecrets {
    /// Send the file drop's password, private key or S3 secret key: from WHK_DROP_SECRET, else typed at the terminal (asked for on its own when adding a file drop)
    #[arg(long)]
    pub drop_secret: bool,

    /// For --format mailgun: send your Mailgun signing key, from WHK_MAILGUN_SIGNING_KEY, else typed at the terminal
    #[arg(long)]
    pub mailgun_signing_key: bool,

    /// Remove the stored Mailgun signing key
    #[arg(long, conflicts_with = "mailgun_signing_key")]
    pub clear_mailgun_signing_key: bool,
}

fn parse_retry(value: &str) -> Result<u32, String> {
    match value.trim() {
        "0" => Ok(0),
        "3600" => Ok(3600),
        "86400" => Ok(86400),
        _ => Err("retries run for 0 (one try), 3600 or 86400 seconds".into()),
    }
}

/// A flag's text, or the contents of the file `@file` names.
fn text_or_file(flag: &str, value: &str) -> Result<String> {
    match value.strip_prefix('@') {
        Some("") => Err(CliError::Usage(format!("{flag} @ needs a file name")).into()),
        Some(file) => {
            std::fs::read_to_string(file).with_context(|| format!("failed to read {file}"))
        }
        None => Ok(value.to_string()),
    }
}

/// A flag holding JSON, or `@file` with JSON in it.
fn json_arg(flag: &str, value: &str) -> Result<Value> {
    let text = text_or_file(flag, value)?;
    serde_json::from_str(&text)
        .map_err(|e| CliError::Usage(format!("{flag} is not valid JSON: {e}")).into())
}

/// `NAME:VALUE` as the API's header, or `NAME` alone to keep what is stored.
fn header_arg(value: &str) -> Result<Value> {
    let (name, value) = match value.split_once(':') {
        Some((name, value)) => (name.trim(), Some(value.trim_start())),
        None => (value.trim(), None),
    };
    if name.is_empty() {
        return Err(CliError::Usage(
            "--header takes NAME:VALUE, or NAME alone to keep its stored value".into(),
        )
        .into());
    }
    Ok(json!({ "name": name, "value": value }))
}

/// The JSON body for the flags given; empty when none were.
pub fn fields_body(fields: &DestinationFields) -> Result<Map<String, Value>> {
    let mut body = Map::new();
    let nullable = |text: &str| {
        if text.trim().is_empty() {
            Value::Null
        } else {
            json!(text.trim())
        }
    };
    if let Some(url) = &fields.url {
        body.insert("url".into(), json!(url.trim()));
    }
    if let Some(name) = &fields.name {
        body.insert("name".into(), nullable(name));
    }
    for (key, value) in [
        ("enabled", fields.enabled),
        ("http", fields.http),
        ("email", fields.email),
        ("appendPath", fields.append_path),
        ("keepOrder", fields.keep_order),
    ] {
        if let Some(value) = value {
            body.insert(key.into(), json!(value));
        }
    }
    if let Some(format) = &fields.format {
        body.insert("format".into(), json!(format));
    }
    if let Some(filter) = &fields.filter {
        let filter = json_arg("--filter", filter)?;
        if !(filter.is_null() || filter.is_object()) {
            return Err(CliError::Usage(
                "--filter takes an object, {\"logic\": \"and\", \"conditions\": [...]}, or null"
                    .into(),
            )
            .into());
        }
        body.insert("filter".into(), filter);
    }
    if let Some(template) = &fields.body_template {
        body.insert(
            "bodyTemplate".into(),
            json_arg("--body-template", template)?,
        );
    }
    if let Some(message) = &fields.message_template {
        let text = text_or_file("--message-template", message)?;
        let value = if text.is_empty() {
            Value::Null
        } else {
            json!(text)
        };
        body.insert("messageTemplate".into(), value);
    }
    if fields.clear_headers {
        body.insert("headers".into(), json!([]));
    } else if !fields.headers.is_empty() {
        let headers = fields
            .headers
            .iter()
            .map(|h| header_arg(h))
            .collect::<Result<Vec<_>>>()?;
        body.insert("headers".into(), Value::Array(headers));
    }
    if let Some(seconds) = fields.retry_seconds {
        body.insert("retrySeconds".into(), json!(seconds));
    }
    if let Some(field) = &fields.sent_field {
        body.insert("sentField".into(), nullable(field));
    }
    if let Some(seconds) = fields.throttle_seconds {
        body.insert("throttleSeconds".into(), json!(seconds));
    }
    if let Some(seconds) = fields.delay_seconds {
        body.insert("delaySeconds".into(), json!(seconds));
    }
    if let Some(attachments) = &fields.attachments {
        body.insert("attachments".into(), json!(attachments));
    }
    if let Some(config) = &fields.config {
        let config = json_arg("--config", config)?;
        if !(config.is_null() || config.is_object()) {
            return Err(CliError::Usage("--config takes a JSON object, or null".into()).into());
        }
        body.insert("config".into(), config);
    }
    Ok(body)
}

/// A secret from `env`, else typed at the terminal without being shown.
/// Never from a flag, and never repeated in an error.
fn read_secret(env: &str, prompt: &str) -> Result<String> {
    if let Ok(value) = std::env::var(env)
        && !value.trim().is_empty()
    {
        return Ok(value);
    }
    if !std::io::stdin().is_terminal() {
        return Err(CliError::Usage(format!(
            "Set {env}, or run this at a terminal to type it (it is never taken from a flag)."
        ))
        .into());
    }
    let value = rpassword::prompt_password(prompt)?;
    if value.trim().is_empty() {
        return Err(CliError::Usage("Nothing was typed.".into()).into());
    }
    Ok(value)
}

/// The API's `dropSecret` for a protocol: the S3 secret key, the FTP
/// password, or for SFTP a private key when it looks like one, else a password.
pub fn drop_secret_value(protocol: &str, secret: &str) -> Result<Value> {
    Ok(match protocol {
        "s3" => json!({ "secretAccessKey": secret }),
        "ftp" | "ftps" => json!({ "password": secret }),
        "sftp" if secret.contains("PRIVATE KEY-----") => json!({ "privateKey": secret }),
        "sftp" => json!({ "password": secret }),
        _ => {
            return Err(CliError::Usage(
                "Give the drop's config (--config with a protocol: sftp, ftp, ftps or s3) before its secret."
                    .into(),
            )
            .into());
        }
    })
}

fn protocol_of(config: Option<&Value>) -> Option<String> {
    config
        .and_then(|c| c.get("protocol"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn add_mailgun_key(body: &mut Map<String, Value>, secrets: &DestinationSecrets) -> Result<()> {
    if secrets.clear_mailgun_signing_key {
        body.insert("mailgunSigningKey".into(), Value::Null);
    } else if secrets.mailgun_signing_key {
        let key = read_secret("WHK_MAILGUN_SIGNING_KEY", "Mailgun signing key: ")?;
        body.insert("mailgunSigningKey".into(), json!(key.trim()));
    }
    Ok(())
}

fn print_json(answer: &crate::api::client::Fetched<Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&answer.json())?);
    Ok(())
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn kinds(d: &Value) -> String {
    let mut out = Vec::new();
    if d.get("http").and_then(Value::as_bool) == Some(true) {
        out.push("http");
    }
    if d.get("email").and_then(Value::as_bool) == Some(true) {
        out.push("email");
    }
    if out.is_empty() {
        "-".into()
    } else {
        out.join(",")
    }
}

fn on_off(d: &Value) -> &'static str {
    if d.get("enabled").and_then(Value::as_bool) == Some(true) {
        "on"
    } else {
        "off"
    }
}

/// Where it sends: the URL, or for a file drop the server in its config.
fn target(d: &Value) -> String {
    if text(d, "format") == "file_drop"
        && let Some(config) = d.get("config")
    {
        let protocol = text(config, "protocol");
        let place = match protocol {
            "s3" => text(config, "bucket").to_string(),
            _ => text(config, "host").to_string(),
        };
        return format!("{protocol}://{place}/{}", text(config, "folder"));
    }
    text(d, "url").to_string()
}

fn last_24h(d: &Value) -> String {
    let Some(summary) = d.get("summary") else {
        return "-".into();
    };
    let count = |field: &str| {
        summary
            .get("last24h")
            .and_then(|l| l.get(field))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    let mut out = format!("{} ok, {} failed", count("delivered"), count("failed"));
    let skipped = count("skipped");
    if skipped > 0 {
        out.push_str(&format!(", {skipped} skipped"));
    }
    let pending = summary.get("pending").and_then(Value::as_u64).unwrap_or(0);
    if pending > 0 {
        out.push_str(&format!(", {pending} waiting"));
    }
    out
}

fn table_lines(list: &[Value]) -> Vec<String> {
    let mut out = vec![format!(
        "  {}",
        dim(&format!(
            "{:<3} {:<5} {:<11} {:<12} {:<28} {}",
            "#", "STATE", "KINDS", "FORMAT", "LAST 24H", "ID"
        ))
    )];
    for (index, d) in list.iter().enumerate() {
        let position = d
            .get("position")
            .and_then(Value::as_u64)
            .map(|p| p + 1)
            .unwrap_or(index as u64 + 1);
        out.push(format!(
            "  {:<3} {:<5} {:<11} {:<12} {:<28} {}",
            position,
            on_off(d),
            kinds(d),
            sanitize(text(d, "format")),
            last_24h(d),
            dim(text(d, "id")),
        ));
        let name = text(d, "name");
        let target = sanitize(&target(d));
        if name.is_empty() {
            out.push(format!("      {target}"));
        } else {
            out.push(format!("      {} {}", bold(&sanitize(name)), dim(&target)));
        }
    }
    out
}

/// The settings of one destination, a line each.
fn detail_lines(d: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = |label: &str, value: String| {
        out.push(format!("  {} {value}", dim(&format!("{label:<12}"))))
    };
    let name = text(d, "name");
    if !name.is_empty() {
        line("Name", bold(&sanitize(name)));
    }
    line("Target", sanitize(&target(d)));
    line("State", on_off(d).into());
    line("Takes", kinds(d));
    line("Format", sanitize(text(d, "format")));
    match d.get("filter").filter(|f| !f.is_null()) {
        Some(filter) => {
            let n = filter
                .get("conditions")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let logic = filter.get("logic").and_then(Value::as_str).unwrap_or("and");
            line(
                "Filter",
                format!("{n} condition{} ({logic})", if n == 1 { "" } else { "s" }),
            );
        }
        None => line("Filter", "none: every capture of its kinds".into()),
    }
    let headers: Vec<String> = d
        .get("headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|h| sanitize(text(h, "name")))
        .collect();
    if !headers.is_empty() {
        line("Headers", headers.join(", "));
    }
    let number = |field: &str| d.get(field).and_then(Value::as_u64).unwrap_or(0);
    line(
        "Retries",
        match number("retrySeconds") {
            0 => "one try".into(),
            3600 => "for an hour".into(),
            86400 => "for a day".into(),
            other => format!("for {other} s"),
        },
    );
    if d.get("keepOrder").and_then(Value::as_bool) == Some(true) {
        line("Order", "one at a time, in capture order".into());
    }
    if number("throttleSeconds") > 0 {
        line(
            "Throttle",
            format!("at most one every {} s", number("throttleSeconds")),
        );
    }
    if number("delaySeconds") > 0 {
        line(
            "Delay",
            format!("{} s after the capture", number("delaySeconds")),
        );
    }
    if let Some(field) = d.get("sentField").and_then(Value::as_str) {
        line("Sent field", sanitize(field));
    }
    if d.get("hasDropSecret").and_then(Value::as_bool) == Some(true) {
        line("Drop secret", "saved (never shown)".into());
    }
    if d.get("hasMailgunSigningKey").and_then(Value::as_bool) == Some(true) {
        line("Mailgun key", "saved (never shown)".into());
    }
    if d.get("hasSecret").and_then(Value::as_bool) == Some(true) {
        line(
            "Secret",
            "set; `whk destinations secret` shows it".to_string(),
        );
    }
    line("ID", dim(text(d, "id")));
    out
}

pub async fn list(client: &ApiClient, slug: &str, summary: bool, json: bool) -> Result<()> {
    // The table always shows the last 24 hours; --json only with --summary,
    // so it prints exactly what was asked for.
    let answer = client.list_destinations(slug, summary || !json).await?;
    if json {
        return print_json(&answer);
    }
    let list = answer.value.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("  No destinations. Add one with `whk destinations add {slug} --url <url>`.");
        return Ok(());
    }
    for line in table_lines(&list) {
        println!("{line}");
    }
    Ok(())
}

pub async fn get(client: &ApiClient, slug: &str, id: &str, json: bool) -> Result<()> {
    let answer = client.get_destination(slug, id.trim()).await?;
    if json {
        return print_json(&answer);
    }
    for line in detail_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

pub async fn add(
    client: &ApiClient,
    slug: &str,
    fields: &DestinationFields,
    secrets: &DestinationSecrets,
    json: bool,
) -> Result<()> {
    let mut body = fields_body(fields)?;
    let drop = fields.format.as_deref() == Some("file_drop");
    if drop {
        let protocol = protocol_of(body.get("config")).unwrap_or_default();
        // Check the protocol before asking, so nobody types a secret for nothing.
        drop_secret_value(&protocol, "-")?;
        let secret = read_secret(
            "WHK_DROP_SECRET",
            "The drop's password, key or secret key: ",
        )?;
        body.insert("dropSecret".into(), drop_secret_value(&protocol, &secret)?);
    } else if secrets.drop_secret {
        return Err(CliError::Usage("--drop-secret is for --format file_drop".into()).into());
    }
    add_mailgun_key(&mut body, secrets)?;
    let answer = client
        .create_destination(slug, &Value::Object(body))
        .await?;
    if json {
        return print_json(&answer);
    }
    println!(
        "{} Added destination {} to {}",
        green("✓"),
        bold(text(&answer.value, "id")),
        bold(&sanitize(slug))
    );
    for line in detail_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

pub async fn update(
    client: &ApiClient,
    slug: &str,
    id: &str,
    fields: &DestinationFields,
    secrets: &DestinationSecrets,
    json: bool,
) -> Result<()> {
    let id = id.trim();
    let mut body = fields_body(fields)?;
    if secrets.drop_secret {
        let protocol = match protocol_of(body.get("config")) {
            Some(protocol) => protocol,
            None => {
                let current = client.get_destination(slug, id).await?;
                protocol_of(current.value.get("config")).unwrap_or_default()
            }
        };
        drop_secret_value(&protocol, "-")?;
        let secret = read_secret(
            "WHK_DROP_SECRET",
            "The drop's password, key or secret key: ",
        )?;
        body.insert("dropSecret".into(), drop_secret_value(&protocol, &secret)?);
    }
    add_mailgun_key(&mut body, secrets)?;
    if body.is_empty() {
        return Err(CliError::Usage(
            "Nothing to change: pass at least one setting (see `whk destinations update --help`)."
                .into(),
        )
        .into());
    }
    let answer = client
        .update_destination(slug, id, &Value::Object(body))
        .await
        .map_err(|error| {
            // The server wants the drop's secret again when it would go to
            // another server; say how to send it, keeping the API's status.
            match error.downcast::<crate::error::ApiError>() {
                Ok(mut api)
                    if !secrets.drop_secret && api.message.contains("password or key again") =>
                {
                    api.message.push_str(
                        " Pass --drop-secret to send it (from WHK_DROP_SECRET, or typed).",
                    );
                    anyhow::Error::new(api)
                }
                Ok(api) => anyhow::Error::new(api),
                Err(error) => error,
            }
        })?;
    if json {
        return print_json(&answer);
    }
    println!(
        "{} Updated destination {}",
        green("✓"),
        bold(text(&answer.value, "id"))
    );
    for line in detail_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

pub async fn remove(client: &ApiClient, slug: &str, id: &str, yes: bool, json: bool) -> Result<()> {
    let id = id.trim();
    confirm(
        &format!(
            "Remove destination {id} from {slug}? What is still waiting for it is marked failed."
        ),
        yes,
    )?;
    let answer = client.delete_destination(slug, id).await?;
    if json {
        return print_json(&answer);
    }
    println!("{} Removed destination {}", red("✓"), bold(id));
    Ok(())
}

pub async fn reorder(client: &ApiClient, slug: &str, ids: &[String], json: bool) -> Result<()> {
    let ids: Vec<String> = ids.iter().map(|id| id.trim().to_string()).collect();
    let answer = client.reorder_destinations(slug, &ids).await?;
    if json {
        return print_json(&answer);
    }
    println!("{} New order for {}", green("✓"), bold(&sanitize(slug)));
    let list = answer.value.as_array().cloned().unwrap_or_default();
    for line in table_lines(&list) {
        println!("{line}");
    }
    Ok(())
}

/// The preview's body: a saved destination, unsaved fields, a request.
pub fn preview_body(
    destination: Option<&str>,
    fields: &DestinationFields,
    request: Option<&str>,
) -> Result<Value> {
    let mut body = Map::new();
    if let Some(id) = destination {
        body.insert("destinationId".into(), json!(id.trim()));
    }
    let draft = fields_body(fields)?;
    if !draft.is_empty() {
        body.insert("destination".into(), Value::Object(draft));
    }
    if let Some(request) = request {
        body.insert("requestId".into(), json!(request.trim()));
    }
    if !body.contains_key("destinationId") && fields.url.is_none() {
        return Err(CliError::Usage(
            "Give --destination <id>, or a --url for a destination not saved yet.".into(),
        )
        .into());
    }
    Ok(Value::Object(body))
}

pub async fn preview(
    client: &ApiClient,
    slug: &str,
    destination: Option<&str>,
    fields: &DestinationFields,
    request: Option<&str>,
    json: bool,
) -> Result<()> {
    let body = preview_body(destination, fields, request)?;
    let answer = client.preview_destination(slug, &body).await?;
    if json {
        return print_json(&answer);
    }
    for line in preview_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

fn request_label(request: &Value) -> String {
    let subject = text(request, "subject");
    let what = if text(request, "kind") == "email" || !subject.is_empty() {
        format!("email \"{}\"", sanitize(subject))
    } else {
        format!(
            "{} {}",
            sanitize(text(request, "method")),
            sanitize(text(request, "path"))
        )
    };
    if request.get("sample").and_then(Value::as_bool) == Some(true) || request["id"].is_null() {
        format!(
            "{what} {}",
            dim("(a sample: nothing of that kind arrived yet)")
        )
    } else {
        format!("{what} {}", dim(text(request, "id")))
    }
}

fn preview_lines(answer: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(request) = answer.get("request") {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "For")),
            request_label(request)
        ));
    }
    if answer.get("takesKind").and_then(Value::as_bool) == Some(false) {
        out.push(format!(
            "  {} The destination does not take this kind, so it would not get it.",
            red("!")
        ));
    }
    let passes = answer.get("filterPasses").and_then(Value::as_bool) == Some(true);
    out.push(format!(
        "  {} {}",
        dim(&format!("{:<8}", "Filter")),
        if passes {
            "lets it through".to_string()
        } else {
            red("turns it down: it would not be sent")
        }
    ));
    out.push(format!(
        "  {} {}",
        dim(&format!("{:<8}", "Format")),
        sanitize(text(answer, "format"))
    ));
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        out.push(format!("  {} {}", red("!"), sanitize(error)));
    }
    if let Some(delivery) = answer.get("delivery").filter(|d| !d.is_null()) {
        out.push(String::new());
        out.push(format!(
            "  {} {}",
            bold(&sanitize(text(delivery, "method"))),
            sanitize(text(delivery, "url"))
        ));
        if let Some(headers) = delivery.get("headers").and_then(Value::as_object) {
            for (name, value) in headers {
                out.push(format!(
                    "  {}: {}",
                    dim(&sanitize(name)),
                    sanitize(value.as_str().unwrap_or(""))
                ));
            }
        }
        if let Some(body) = delivery.get("body").and_then(Value::as_str) {
            out.push(String::new());
            for line in body.lines() {
                out.push(format!("  {}", crate::cli::output::sanitize_line(line)));
            }
        } else if delivery.get("bodyBase64").and_then(Value::as_str).is_some() {
            out.push(String::new());
            out.push(format!(
                "  {}",
                dim("(a binary body; --json has it as base64)")
            ));
        }
    }
    out.push(String::new());
    out.push(format!("  {}", dim("A dry run: nothing was sent.")));
    out
}

/// The test's body: a request to send, or the newest of a kind.
pub fn test_body(request: Option<&str>, kind: Option<&str>) -> Value {
    let mut body = Map::new();
    if let Some(request) = request {
        body.insert("requestId".into(), json!(request.trim()));
    }
    if let Some(kind) = kind {
        body.insert("kind".into(), json!(kind));
    }
    Value::Object(body)
}

pub async fn test(
    client: &ApiClient,
    slug: &str,
    id: &str,
    request: Option<&str>,
    kind: Option<&str>,
    yes: bool,
    json: bool,
) -> Result<()> {
    let id = id.trim();
    confirm(
        &format!("Send a test delivery to destination {id} of {slug} now?"),
        yes,
    )?;
    let answer = client
        .test_destination(slug, id, &test_body(request, kind))
        .await?;
    if json {
        return print_json(&answer);
    }
    for line in test_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

fn test_lines(answer: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let delivered = answer.get("delivered").and_then(Value::as_bool) == Some(true);
    let ms = answer
        .get("durationMs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let status = answer
        .get("status")
        .and_then(Value::as_u64)
        .map(|s| s.to_string());
    let headline = match (delivered, &status) {
        (true, Some(status)) => format!("{} Delivered: {status} in {ms} ms", green("✓")),
        (true, None) => format!("{} Delivered in {ms} ms", green("✓")),
        (false, Some(status)) => format!("{} Not delivered: {status} in {ms} ms", red("✗")),
        (false, None) => format!("{} Not delivered ({ms} ms)", red("✗")),
    };
    out.push(headline);
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "Error")),
            sanitize(error)
        ));
    }
    let to = answer
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| answer.get("target").and_then(Value::as_str));
    if let Some(to) = to {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "To")),
            sanitize(to)
        ));
    }
    if let Some(file) = answer.get("file").and_then(Value::as_str) {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "File")),
            sanitize(file)
        ));
    }
    if let Some(request) = answer.get("request").filter(|r| !r.is_null()) {
        let mut request = request.clone();
        if answer.get("sample").and_then(Value::as_bool) == Some(true) {
            request["sample"] = json!(true);
        }
        if answer.get("kind").and_then(Value::as_str) == Some("email") {
            request["kind"] = json!("email");
        }
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "Sent")),
            request_label(&request)
        ));
    }
    if let Some(excerpt) = answer.get("excerpt").and_then(Value::as_str)
        && !excerpt.is_empty()
    {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "Answer")),
            crate::cli::output::sanitize_line(excerpt)
        ));
    }
    if answer.get("filterPasses").and_then(Value::as_bool) == Some(false) {
        out.push(format!(
            "  {}",
            dim("Its filter would turn this request down; a test sends it anyway.")
        ));
    }
    out
}

pub async fn secret(
    client: &ApiClient,
    slug: &str,
    id: &str,
    rotate: bool,
    yes: bool,
    json: bool,
) -> Result<()> {
    let id = id.trim();
    if rotate {
        confirm(
            &format!(
                "Replace the signing secret of destination {id}? Deliveries are signed with the new one at once, so your server must check them with it."
            ),
            yes,
        )?;
    }
    let answer = client.destination_secret(slug, id, rotate).await?;
    if json {
        return print_json(&answer);
    }
    // Only the secret on stdout, so `$(whk destinations secret ...)` works.
    println!("{}", text(&answer.value, "secret"));
    if rotate {
        eprintln!(
            "{}",
            dim("Replaced: deliveries are signed with this secret from now on.")
        );
    }
    Ok(())
}

pub(crate) fn when(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_i64)
        .map(format_timestamp)
        .unwrap_or_else(|| "-".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;

    fn fields() -> DestinationFields {
        DestinationFields::default()
    }

    #[test]
    fn only_the_flags_given_are_sent() {
        assert!(fields_body(&fields()).unwrap().is_empty());
        let body = fields_body(&DestinationFields {
            url: Some(" https://example.com/hooks ".into()),
            name: Some("".into()),
            http: Some(false),
            email: Some(true),
            format: Some("json".into()),
            retry_seconds: Some(3600),
            throttle_seconds: Some(0),
            sent_field: Some("created_at".into()),
            ..fields()
        })
        .unwrap();
        assert_eq!(
            Value::Object(body),
            json!({
                "url": "https://example.com/hooks", "name": null, "http": false,
                "email": true, "format": "json", "retrySeconds": 3600,
                "throttleSeconds": 0, "sentField": "created_at"
            })
        );
    }

    #[test]
    fn headers_replace_the_set_and_a_bare_name_keeps_its_value() {
        let body = fields_body(&DestinationFields {
            headers: vec!["Authorization: Bearer abc".into(), "X-Kept".into()],
            ..fields()
        })
        .unwrap();
        assert_eq!(
            body["headers"],
            json!([
                { "name": "Authorization", "value": "Bearer abc" },
                { "name": "X-Kept", "value": null }
            ])
        );
        let cleared = fields_body(&DestinationFields {
            clear_headers: true,
            ..fields()
        })
        .unwrap();
        assert_eq!(cleared["headers"], json!([]));
        let error = fields_body(&DestinationFields {
            headers: vec![": value".into()],
            ..fields()
        })
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[test]
    fn json_flags_take_json_null_or_a_file() {
        let body = fields_body(&DestinationFields {
            filter: Some(r#"{"conditions":[{"field":"method","op":"eq","value":"POST"}]}"#.into()),
            body_template: Some(r#"{"id":"{{ json.id }}"}"#.into()),
            ..fields()
        })
        .unwrap();
        assert_eq!(body["filter"]["conditions"][0]["value"], "POST");
        assert_eq!(body["bodyTemplate"]["id"], "{{ json.id }}");

        let cleared = fields_body(&DestinationFields {
            filter: Some("null".into()),
            message_template: Some("".into()),
            ..fields()
        })
        .unwrap();
        assert!(cleared["filter"].is_null() && cleared["messageTemplate"].is_null());

        let dir = std::env::temp_dir().join(format!("whk-dest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        std::fs::write(&file, r#"{"protocol":"sftp","host":"files.example.com"}"#).unwrap();
        let from_file = fields_body(&DestinationFields {
            config: Some(format!("@{}", file.display())),
            ..fields()
        })
        .unwrap();
        assert_eq!(from_file["config"]["protocol"], "sftp");
        std::fs::remove_dir_all(&dir).ok();

        for bad in [
            DestinationFields {
                filter: Some("[1]".into()),
                ..fields()
            },
            DestinationFields {
                body_template: Some("{not json".into()),
                ..fields()
            },
            DestinationFields {
                config: Some("@".into()),
                ..fields()
            },
        ] {
            let error = fields_body(&bad).unwrap_err();
            assert_eq!(classify(&error).code, "usage", "{bad:?}");
        }
    }

    #[test]
    fn a_drop_secret_goes_where_its_protocol_reads_it() {
        assert_eq!(
            drop_secret_value("s3", "k").unwrap(),
            json!({ "secretAccessKey": "k" })
        );
        assert_eq!(
            drop_secret_value("ftps", "p").unwrap(),
            json!({ "password": "p" })
        );
        assert_eq!(
            drop_secret_value("sftp", "p").unwrap(),
            json!({ "password": "p" })
        );
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(
            drop_secret_value("sftp", key).unwrap(),
            json!({ "privateKey": key })
        );
        let error = drop_secret_value("", "hunter2").unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert!(!format!("{error:#}").contains("hunter2"));
    }

    #[test]
    fn a_preview_needs_a_saved_destination_or_a_url() {
        let error = preview_body(None, &fields(), None).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert_eq!(
            preview_body(Some("d1"), &fields(), Some("r1")).unwrap(),
            json!({ "destinationId": "d1", "requestId": "r1" })
        );
        let draft = preview_body(
            Some("d1"),
            &DestinationFields {
                format: Some("chat".into()),
                ..fields()
            },
            None,
        )
        .unwrap();
        assert_eq!(draft["destination"], json!({ "format": "chat" }));
        let unsaved = preview_body(
            None,
            &DestinationFields {
                url: Some("https://example.com/hooks".into()),
                ..fields()
            },
            None,
        )
        .unwrap();
        assert_eq!(unsaved["destination"]["url"], "https://example.com/hooks");
    }

    #[test]
    fn a_test_sends_only_what_was_given() {
        assert_eq!(test_body(None, None), json!({}));
        assert_eq!(
            test_body(Some(" r1 "), Some("email")),
            json!({ "requestId": "r1", "kind": "email" })
        );
    }

    #[test]
    fn lists_destinations_with_their_last_day() {
        let lines = table_lines(&[json!({
            "id": "d1", "position": 0, "name": "Acme server", "enabled": true,
            "url": "https://example.com/hooks", "http": true, "email": false,
            "format": "as_received",
            "summary": { "last24h": { "delivered": 3, "failed": 1, "skipped": 0 }, "pending": 2 }
        })])
        .join("\n");
        assert!(lines.contains("http "), "{lines}");
        assert!(lines.contains("3 ok, 1 failed, 2 waiting"), "{lines}");
        assert!(lines.contains("Acme server"), "{lines}");
        assert!(lines.contains("https://example.com/hooks"), "{lines}");
    }

    #[test]
    fn a_file_drop_is_named_by_its_server() {
        let d = json!({
            "format": "file_drop",
            "config": { "protocol": "sftp", "host": "files.example.com", "folder": "in" }
        });
        assert_eq!(target(&d), "sftp://files.example.com/in");
    }

    #[test]
    fn details_never_show_secrets() {
        let lines = detail_lines(&json!({
            "id": "d1", "enabled": false, "url": "https://example.com", "http": true,
            "email": true, "format": "file_drop", "hasSecret": true, "hasDropSecret": true,
            "headers": [{ "name": "Authorization", "value": "Bea***" }],
            "retrySeconds": 86400, "filter": { "logic": "or", "conditions": [{}, {}] },
            "config": { "protocol": "s3", "bucket": "acme", "folder": "" }
        }))
        .join("\n");
        assert!(lines.contains("Authorization"), "{lines}");
        assert!(!lines.contains("Bea***"), "{lines}");
        assert!(lines.contains("2 conditions (or)"), "{lines}");
        assert!(lines.contains("for a day"), "{lines}");
        assert!(lines.contains("s3://acme/"), "{lines}");
        assert!(lines.contains("saved (never shown)"), "{lines}");
    }

    #[test]
    fn shows_what_a_preview_would_send() {
        let lines = preview_lines(&json!({
            "request": { "id": null, "kind": "http", "method": "POST", "path": "/", "subject": null, "receivedAt": 0, "sample": true },
            "takesKind": true, "filterPasses": false, "format": "json",
            "delivery": { "method": "POST", "url": "https://example.com/hooks",
                "headers": { "content-type": "application/json" }, "body": "{\"a\":1}", "bodyBase64": null },
            "error": null
        }))
        .join("\n");
        assert!(lines.contains("a sample"), "{lines}");
        assert!(lines.contains("turns it down"), "{lines}");
        assert!(lines.contains("https://example.com/hooks"), "{lines}");
        assert!(lines.contains("{\"a\":1}"), "{lines}");
        assert!(lines.contains("nothing was sent"), "{lines}");
    }

    #[test]
    fn reports_a_failed_test() {
        let lines = test_lines(&json!({
            "status": null, "durationMs": 12, "excerpt": null,
            "error": "getaddrinfo ENOTFOUND example.invalid", "delivered": false,
            "sample": true, "kind": "http", "format": "as_received",
            "url": "https://example.invalid/hook", "filterPasses": true,
            "request": { "id": null, "method": "POST", "path": "/", "subject": null, "receivedAt": 0 }
        }))
        .join("\n");
        assert!(lines.contains("Not delivered"), "{lines}");
        assert!(lines.contains("ENOTFOUND"), "{lines}");
        assert!(lines.contains("https://example.invalid/hook"), "{lines}");
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
    async fn an_update_sends_only_the_changed_fields() {
        let sent: std::sync::Arc<std::sync::Mutex<Option<Value>>> = Default::default();
        let seen = sent.clone();
        let app = axum::Router::new().route(
            "/api/endpoints/{slug}/destinations/{id}",
            axum::routing::patch(
                move |axum::extract::Path((slug, id)): axum::extract::Path<(String, String)>,
                      axum::Json(body): axum::Json<Value>| async move {
                    assert_eq!((slug.as_str(), id.as_str()), ("acme", "d1"));
                    *seen.lock().unwrap() = Some(body);
                    axum::Json(
                        json!({ "id": "d1", "enabled": false, "url": "https://example.com" }),
                    )
                },
            ),
        );
        let base = serve(app).await;
        update(
            &client(&base),
            "acme",
            "d1",
            &DestinationFields {
                enabled: Some(false),
                ..fields()
            },
            &DestinationSecrets::default(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            sent.lock().unwrap().clone(),
            Some(json!({ "enabled": false }))
        );
    }

    #[tokio::test]
    async fn an_empty_update_is_refused_before_any_call() {
        let error = update(
            &client("http://127.0.0.1:9"),
            "acme",
            "d1",
            &fields(),
            &DestinationSecrets::default(),
            true,
        )
        .await
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[tokio::test]
    async fn rotating_a_secret_posts_and_reading_one_gets() {
        let rotated: std::sync::Arc<std::sync::Mutex<usize>> = Default::default();
        let count = rotated.clone();
        let app = axum::Router::new().route(
            "/api/endpoints/{slug}/destinations/{id}/secret",
            axum::routing::get(|| async { axum::Json(json!({ "secret": "whsec_old" })) }).post(
                move || {
                    let count = count.clone();
                    async move {
                        *count.lock().unwrap() += 1;
                        axum::Json(json!({ "secret": "whsec_new" }))
                    }
                },
            ),
        );
        let base = serve(app).await;
        secret(&client(&base), "acme", "d1", false, false, true)
            .await
            .unwrap();
        assert_eq!(*rotated.lock().unwrap(), 0);
        secret(&client(&base), "acme", "d1", true, true, true)
            .await
            .unwrap();
        assert_eq!(*rotated.lock().unwrap(), 1);
    }
}
