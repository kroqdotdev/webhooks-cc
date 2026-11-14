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
use crate::cli::output::{bold, dim, green, red, sanitize_line};
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

    /// For --format chat: the message text with {{ placeholders }}, or @file; start with @@ for a literal @ ("" sends the standard message)
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
    /// Send the file drop's password, private key or S3 secret key: from WHK_DROP_SECRET (a key as WHK_DROP_SECRET="$(cat ~/.ssh/<key>)"), else typed or pasted at the terminal (asked for on its own when adding a file drop)
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

/// The most a flag's `@file` may hold. The server takes far less (a
/// template is at most 64 KB); this only stops a wrong file being read whole.
const MAX_FLAG_FILE_BYTES: u64 = 1024 * 1024;

/// A flag's text, or the contents of the file `@file` names. A leading `@@`
/// stands for a literal `@`, so `@@everyone` sends `@everyone`.
pub(crate) fn text_or_file(flag: &str, value: &str) -> Result<String> {
    if let Some(rest) = value.strip_prefix("@@") {
        return Ok(format!("@{rest}"));
    }
    match value.strip_prefix('@') {
        Some("") => Err(CliError::Usage(format!("{flag} @ needs a file name")).into()),
        Some(file) => read_flag_file(flag, file),
        None => Ok(value.to_string()),
    }
}

fn read_flag_file(flag: &str, file: &str) -> Result<String> {
    use std::io::Read;
    let handle = match std::fs::File::open(file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(CliError::Usage(format!(
                "{flag}: there is no file {file:?}. A value that starts with @ names a file; write @@ for a literal @ (\"@@{file}\")."
            ))
            .into());
        }
        Err(e) => return Err(e).with_context(|| format!("failed to read {file}")),
    };
    let mut bytes = Vec::new();
    handle
        .take(MAX_FLAG_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {file}"))?;
    if bytes.len() as u64 > MAX_FLAG_FILE_BYTES {
        return Err(CliError::Usage(format!(
            "{file} is over 1 MB, too big for {flag}. (To send text starting with @, write @@.)"
        ))
        .into());
    }
    String::from_utf8(bytes).map_err(|_| {
        CliError::Usage(format!("{file} is not UTF-8 text, which {flag} takes")).into()
    })
}

/// A flag holding JSON, or `@file` with JSON in it.
pub(crate) fn json_arg(flag: &str, value: &str) -> Result<Value> {
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
/// Never from a flag, and never repeated in an error. A pasted private key
/// (a `-----BEGIN` line) is read on to its `-----END` line, so the rest of
/// the paste never reaches the shell once whk exits.
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
    // Echo stays off from the first prompt to the last line of a pasted key.
    let _hidden = HiddenInput::new();
    let first = rpassword::prompt_password(prompt).map_err(read_error)?;
    if first.trim().is_empty() {
        return Err(CliError::Usage("Nothing was typed.".into()).into());
    }
    pem_or_line(first, env, rpassword::read_password)
}

/// A failed hidden read; Ctrl-C (which rpassword reports as Interrupted)
/// is a cancel.
fn read_error(e: std::io::Error) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::Interrupted {
        CliError::Cancelled.into()
    } else {
        e.into()
    }
}

/// Keeps the terminal from echoing while a secret is read over several
/// hidden prompts. rpassword puts back the terminal it found after each line,
/// so with this guard that is echo off, and a pasted key's later lines never
/// show between two prompts. Ctrl-C is ignored meanwhile: rpassword answers
/// it by raising SIGINT, which then only ends the read with an error, so this
/// guard's drop restores echo rather than the process dying with it off.
#[cfg(unix)]
struct HiddenInput {
    tty: std::fs::File,
    saved: libc::termios,
    sigint: libc::sighandler_t,
}

#[cfg(unix)]
impl HiddenInput {
    fn new() -> Option<Self> {
        use std::os::fd::AsRawFd;
        let tty = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        let fd = tty.as_raw_fd();
        let mut saved = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: tcgetattr fills the termios on success, checked before use.
        if unsafe { libc::tcgetattr(fd, saved.as_mut_ptr()) } != 0 {
            return None;
        }
        let saved = unsafe { saved.assume_init() };
        let mut quiet = saved;
        quiet.c_lflag &= !(libc::ECHO | libc::ECHONL);
        // SAFETY: plain calls on an open descriptor and a valid termios.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &quiet) } != 0 {
            return None;
        }
        let sigint = unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
        Some(Self { tty, saved, sigint })
    }
}

#[cfg(unix)]
impl Drop for HiddenInput {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: restores what `new` saved, on the descriptor it opened.
        unsafe {
            libc::tcsetattr(self.tty.as_raw_fd(), libc::TCSANOW, &self.saved);
            libc::signal(libc::SIGINT, self.sigint);
        }
    }
}

/// Windows prompts are left as rpassword makes them.
#[cfg(not(unix))]
struct HiddenInput;

#[cfg(not(unix))]
impl HiddenInput {
    fn new() -> Option<Self> {
        Some(Self)
    }
}

/// The most lines and bytes a pasted key may take. A 16384-bit RSA key in
/// PEM is about 160 lines and 13 KB; an Ed25519 key is 7 lines.
const MAX_PEM_LINES: usize = 200;
const MAX_PEM_BYTES: usize = 16 * 1024;

/// Whether the key so far ends with a PEM header line (`Name: value`).
fn after_header(key: &str) -> bool {
    key.trim_end()
        .lines()
        .last()
        .is_some_and(|line| line.contains(':'))
}

/// The typed line as it is, or when it opens a PEM block (a private key), the
/// whole block: further hidden lines from `next_line` up to the matching
/// `-----END ...-----`, bounded so a paste that never ends is refused.
fn pem_or_line(
    first: String,
    env: &str,
    mut next_line: impl FnMut() -> std::io::Result<String>,
) -> Result<String> {
    let opening = first.trim();
    // The label runs to the first `-----` after BEGIN.
    let Some(label) = opening
        .strip_prefix("-----BEGIN ")
        .and_then(|rest| rest.split_once("-----"))
        .map(|(label, _)| label)
        .filter(|label| !label.is_empty())
    else {
        return Ok(first);
    };
    // A key pasted as one line already holds its end: the server judges it.
    if opening.contains("-----END") {
        return Ok(first);
    }
    let end = format!("-----END {label}-----");
    let too_long = || -> anyhow::Error {
        CliError::Usage(format!(
            "That key did not end with {end} within {MAX_PEM_LINES} lines and 16 KB. Pass the key from its file instead: {env}=\"$(cat ~/.ssh/<key>)\" whk ..."
        ))
        .into()
    };
    let mut key = String::from(opening);
    key.push('\n');
    for _ in 0..MAX_PEM_LINES {
        let line = next_line().map_err(read_error)?;
        let line = line.trim();
        // One blank line belongs after the headers (`DEK-Info: ...`); other
        // blanks are the second half of a pasted \r\n.
        if line.is_empty() && (key.ends_with("\n\n") || !after_header(&key)) {
            continue;
        }
        key.push_str(line);
        key.push('\n');
        if key.len() > MAX_PEM_BYTES {
            return Err(too_long());
        }
        if line == end {
            return Ok(key);
        }
    }
    Err(too_long())
}

/// The API's `dropSecret` for a protocol: the S3 secret key, the FTP
/// password, or for SFTP a private key when it looks like one, else a password.
pub fn drop_secret_value(protocol: &str, secret: &str) -> Result<Value> {
    Ok(match protocol {
        "s3" => json!({ "secretAccessKey": secret }),
        "ftp" | "ftps" => json!({ "password": secret }),
        // A key in PEM or OpenSSH form, or a PuTTY key file, which the server reads too.
        "sftp"
            if secret.contains("PRIVATE KEY-----")
                || secret.trim_start().starts_with("PuTTY-User-Key-File-") =>
        {
            json!({ "privateKey": secret })
        }
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
            sanitize_line(text(d, "format")),
            last_24h(d),
            dim(text(d, "id")),
        ));
        let name = text(d, "name");
        let target = sanitize_line(&target(d));
        if name.is_empty() {
            out.push(format!("      {target}"));
        } else {
            out.push(format!(
                "      {} {}",
                bold(&sanitize_line(name)),
                dim(&target)
            ));
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
        line("Name", bold(&sanitize_line(name)));
    }
    line("Target", sanitize_line(&target(d)));
    line("State", on_off(d).into());
    line("Takes", kinds(d));
    line("Format", sanitize_line(text(d, "format")));
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
        .map(|h| sanitize_line(text(h, "name")))
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
        line("Sent field", sanitize_line(field));
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
        bold(&sanitize_line(slug))
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
    println!(
        "{} New order for {}",
        green("✓"),
        bold(&sanitize_line(slug))
    );
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
        format!("email \"{}\"", sanitize_line(subject))
    } else {
        format!(
            "{} {}",
            sanitize_line(text(request, "method")),
            sanitize_line(text(request, "path"))
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
        sanitize_line(text(answer, "format"))
    ));
    if let Some(error) = answer.get("error").and_then(Value::as_str) {
        out.push(format!("  {} {}", red("!"), sanitize_line(error)));
    }
    if let Some(delivery) = answer.get("delivery").filter(|d| !d.is_null()) {
        out.push(String::new());
        out.push(format!(
            "  {} {}",
            bold(&sanitize_line(text(delivery, "method"))),
            sanitize_line(text(delivery, "url"))
        ));
        if let Some(headers) = delivery.get("headers").and_then(Value::as_object) {
            for (name, value) in headers {
                out.push(format!(
                    "  {}: {}",
                    dim(&sanitize_line(name)),
                    sanitize_line(value.as_str().unwrap_or(""))
                ));
            }
        }
        if let Some(body) = delivery.get("body").and_then(Value::as_str) {
            out.push(String::new());
            for line in body.lines() {
                out.push(format!("  {}", sanitize_line(line)));
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
    // The result goes to stdout either way; a failed delivery then exits
    // non-zero with `delivery_failed` on stderr.
    if json {
        print_json(&answer)?;
    } else {
        for line in test_lines(&answer.value) {
            println!("{line}");
        }
    }
    match test_failure(id, &answer.value) {
        Some(error) => Err(error.into()),
        None => Ok(()),
    }
}

/// The error for a test the destination did not accept, or None when it
/// was delivered.
fn test_failure(id: &str, answer: &Value) -> Option<CliError> {
    if answer.get("delivered").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let status = answer.get("status").and_then(Value::as_u64);
    let error = answer
        .get("error")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty());
    let id = sanitize_line(id);
    Some(CliError::DeliveryFailed(match (status, error) {
        (Some(status), _) => {
            format!("The test delivery to destination {id} was not accepted: it answered {status}.")
        }
        (None, Some(error)) => format!(
            "The test delivery to destination {id} failed: {}",
            sanitize_line(error)
        ),
        (None, None) => format!("The test delivery to destination {id} failed."),
    }))
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
            sanitize_line(error)
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
            sanitize_line(to)
        ));
    }
    if let Some(file) = answer.get("file").and_then(Value::as_str) {
        out.push(format!(
            "  {} {}",
            dim(&format!("{:<8}", "File")),
            sanitize_line(file)
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
    fn a_double_at_is_a_literal_at() {
        let body = fields_body(&DestinationFields {
            message_template: Some("@@everyone deploy failed".into()),
            ..fields()
        })
        .unwrap();
        assert_eq!(body["messageTemplate"], "@everyone deploy failed");
        assert_eq!(text_or_file("--message-template", "@@").unwrap(), "@");
        assert_eq!(
            text_or_file("--message-template", "plain @ text").unwrap(),
            "plain @ text"
        );
    }

    #[test]
    fn a_flag_file_is_capped() {
        let dir = std::env::temp_dir().join(format!("whk-dest-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.txt");
        std::fs::write(&big, vec![b'a'; MAX_FLAG_FILE_BYTES as usize + 1]).unwrap();
        let error = text_or_file("--message-template", &format!("@{}", big.display())).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        assert!(format!("{error}").contains("over 1 MB"), "{error}");

        let fits = dir.join("fits.txt");
        std::fs::write(&fits, vec![b'a'; MAX_FLAG_FILE_BYTES as usize]).unwrap();
        let text = text_or_file("--message-template", &format!("@{}", fits.display())).unwrap();
        assert_eq!(text.len(), MAX_FLAG_FILE_BYTES as usize);

        let binary = dir.join("binary.bin");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        let error =
            text_or_file("--message-template", &format!("@{}", binary.display())).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Lines as the hidden prompt hands them over, then end of input.
    fn lines(list: &[&str]) -> impl FnMut() -> std::io::Result<String> {
        let mut rest: std::collections::VecDeque<String> =
            list.iter().map(|l| (*l).to_string()).collect();
        move || Ok(rest.pop_front().unwrap_or_default())
    }

    #[test]
    fn a_typed_password_is_one_line() {
        let mut called = false;
        let secret = pem_or_line("hunter2".into(), "WHK_DROP_SECRET", || {
            called = true;
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(secret, "hunter2");
        assert!(!called, "a password reads no further lines");
    }

    #[test]
    fn a_pasted_key_is_read_to_its_end_line() {
        let key = pem_or_line(
            "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
            "WHK_DROP_SECRET",
            lines(&[
                "made-up first line",
                "",
                "made-up second line",
                "-----END OPENSSH PRIVATE KEY-----",
                "echo this stays unread",
            ]),
        )
        .unwrap();
        assert_eq!(
            key,
            "-----BEGIN OPENSSH PRIVATE KEY-----\n\
             made-up first line\n\
             made-up second line\n\
             -----END OPENSSH PRIVATE KEY-----\n"
        );
        assert_eq!(
            drop_secret_value("sftp", &key).unwrap()["privateKey"],
            json!(key)
        );
    }

    #[test]
    fn a_pem_header_keeps_its_blank_line() {
        let key = pem_or_line(
            "-----BEGIN RSA PRIVATE KEY-----".into(),
            "WHK_DROP_SECRET",
            lines(&[
                "Proc-Type: 4,ENCRYPTED",
                "DEK-Info: AES-128-CBC,0011",
                "",
                "",
                "made-up body",
                "",
                "-----END RSA PRIVATE KEY-----",
            ]),
        )
        .unwrap();
        assert!(key.contains("0011\n\nmade-up body"), "{key}");
        assert!(key.contains("body\n-----END"), "{key}");
    }

    #[test]
    fn an_indented_paste_is_trimmed_line_by_line() {
        let key = pem_or_line(
            "   -----BEGIN OPENSSH PRIVATE KEY-----  ".into(),
            "WHK_DROP_SECRET",
            lines(&[
                "    made-up line\r",
                "\t-----END OPENSSH PRIVATE KEY-----   ",
            ]),
        )
        .unwrap();
        assert_eq!(
            key,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up line\n-----END OPENSSH PRIVATE KEY-----\n"
        );
    }

    #[test]
    fn a_key_pasted_as_one_line_is_sent_as_it_is() {
        let one_line =
            "-----BEGIN OPENSSH PRIVATE KEY----- made-up -----END OPENSSH PRIVATE KEY-----";
        let secret = pem_or_line(one_line.into(), "WHK_DROP_SECRET", || {
            panic!("reads no further line")
        })
        .unwrap();
        assert_eq!(secret, one_line);
        // A BEGIN line with text after its label reads to the END of that label.
        let key = pem_or_line(
            "-----BEGIN RSA PRIVATE KEY-----extra".into(),
            "WHK_DROP_SECRET",
            lines(&["made-up", "-----END RSA PRIVATE KEY-----"]),
        )
        .unwrap();
        assert!(key.ends_with("-----END RSA PRIVATE KEY-----\n"), "{key}");
    }

    #[test]
    fn ctrl_c_at_the_prompt_cancels() {
        let error = pem_or_line(
            "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
            "WHK_DROP_SECRET",
            || Err(std::io::Error::from(std::io::ErrorKind::Interrupted)),
        )
        .unwrap_err();
        assert_eq!(classify(&error).code, "cancelled");
    }

    #[test]
    fn an_at_that_names_no_file_suggests_a_double_at() {
        let error = text_or_file("--message-template", "@here deploy failed").unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        let message = format!("{error}");
        assert!(message.contains("\"@@here deploy failed\""), "{message}");
    }

    #[test]
    fn a_key_without_its_end_line_is_refused() {
        let error = pem_or_line(
            "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
            "WHK_DROP_SECRET",
            lines(&["abc", "def"]),
        )
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
        let message = format!("{error}");
        assert!(message.contains("WHK_DROP_SECRET=\"$(cat"), "{message}");
        assert!(!message.contains("abc"), "never repeats the key: {message}");

        let mut endless = || Ok("A".repeat(70));
        let error = pem_or_line(
            "-----BEGIN OPENSSH PRIVATE KEY-----".into(),
            "WHK_DROP_SECRET",
            &mut endless,
        )
        .unwrap_err();
        assert_eq!(classify(&error).code, "usage");
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
        let ppk = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n";
        assert_eq!(
            drop_secret_value("sftp", ppk).unwrap(),
            json!({ "privateKey": ppk })
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
    fn a_crafted_subject_or_path_stays_on_one_line() {
        let email = request_label(&json!({
            "id": "r1", "kind": "email", "subject": "Hi\n  POST /fake  r2\r\nmore"
        }));
        assert!(!email.contains('\n') && !email.contains('\r'), "{email}");
        let http = request_label(&json!({
            "id": "r1", "kind": "http", "method": "POST", "path": "/a\n  GET /b"
        }));
        assert!(!http.contains('\n'), "{http}");
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

    #[test]
    fn a_failed_test_exits_with_delivery_failed() {
        let delivered = json!({ "delivered": true, "status": 200, "durationMs": 40 });
        assert!(test_failure("d1", &delivered).is_none());

        let refused = json!({ "delivered": false, "status": 502, "error": null });
        let error = anyhow::Error::new(test_failure("d1", &refused).unwrap());
        let c = classify(&error);
        assert_eq!((c.code, c.exit), ("delivery_failed", 1));
        assert!(error.to_string().contains("502"), "{error}");

        let unreachable = json!({
            "delivered": false, "status": null,
            "error": "getaddrinfo ENOTFOUND example.invalid"
        });
        let error = test_failure("d1", &unreachable).unwrap().to_string();
        assert!(error.contains("ENOTFOUND"), "{error}");
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
    async fn a_test_the_destination_refused_fails_after_printing() {
        let app = axum::Router::new().route(
            "/api/endpoints/{slug}/destinations/{id}/test",
            axum::routing::post(|| async {
                axum::Json(json!({ "delivered": false, "status": 401, "durationMs": 30 }))
            }),
        );
        let base = serve(app).await;
        let error = test(&client(&base), "acme", "d1", None, None, true, true)
            .await
            .unwrap_err();
        assert_eq!(classify(&error).code, "delivery_failed");
        assert_eq!(classify(&error).exit, 1);
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
