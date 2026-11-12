//! `whk share`, `whk shares` and `whk names`: share a local port at a link
//! on sharehooks.cc, see and stop shares, and keep names to share under.

use std::io::IsTerminal;

use anyhow::{Result, bail};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize, sanitize_line};
use crate::share::events::{self, Event};
use crate::share::{self, Kind, Session, Update, duration, printable};
use crate::types::{
    NamesResponse, Share, ShareRequestsResponse, SharesResponse, TunnelLimits, TunnelName,
    TunnelUsage,
};

pub struct ShareOptions {
    pub target: String,
    pub name: Option<String>,
    pub password: bool,
    pub no_qr: bool,
    pub until_stdin_closes: bool,
    pub json: bool,
}

/// `whk share <port>`: runs until Ctrl-C, the edge stops it, or (with
/// `--until-stdin-closes`) the program that started it ends.
pub async fn run(client: &ApiClient, options: ShareOptions) -> Result<()> {
    let json = options.json;
    let result = run_inner(client, options).await;
    if json && let Err(e) = &result {
        Event::Error {
            message: &format!("{e:#}"),
        }
        .print();
        events::flush(events::FINAL_WAIT);
        std::process::exit(1);
    }
    // What the share printed is out before the error, or the exit.
    events::flush(events::FINAL_WAIT);
    result
}

async fn run_inner(client: &ApiClient, options: ShareOptions) -> Result<()> {
    client.require_auth()?;
    let target = share::parse_share_target(&options.target)?;
    let password = if options.password {
        Some(share::read_password()?)
    } else {
        None
    };
    let session = Session {
        tunnel_url: share::tunnel_url(),
        api: client.clone(),
        kind: Kind::Share {
            name: options.name.clone(),
            password,
        },
        host: target.host,
        port: target.port,
        rewrite: None,
        client: share::client_name(),
        on_relayed: None,
    };
    let json = options.json;
    let qr = !json && !options.no_qr && share::qr::wanted(std::io::stdout().is_terminal());

    // Said once, at the start: the share still opens, and visitors see a
    // waiting page until the local server answers.
    if !share::local_answers(target).await {
        let text = nothing_yet(target);
        if json {
            Event::Notice { text: &text }.print();
        } else {
            events::out(format!("  {} {}", dim("●"), dim(&text)), false);
        }
    }

    if options.until_stdin_closes {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            stopped(json, "the program that started it ended");
            std::process::exit(0);
        });
    }

    let shown = target.display();
    let mut show = |update: Update| show_share_update(update, &shown, json, qr);
    tokio::select! {
        result = share::run(&session, &mut show) => {
            let reason = result?;
            stopped(json, &reason);
        }
        _ = shutdown_signal() => {
            stopped(json, "you stopped it on this computer");
            // Through the share's own queue, so a stalled terminal cannot
            // hold the exit past FINAL_WAIT.
            if let Some(hint) = crate::util::star::take(json) {
                events::out(hint, false);
                events::flush(events::FINAL_WAIT);
            }
        }
    }
    Ok(())
}

/// The warning when nothing answers on the local port at the start.
pub fn nothing_yet(target: share::LocalTarget) -> String {
    format!(
        "Nothing answers on {} yet; visitors see a waiting page until it does.",
        target.display()
    )
}

/// Ctrl-C, or on Unix SIGTERM too (what `kill` and process managers send),
/// so either ends a share the same way.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The last line of a share, once the lines before it are out (or a reader
/// that stopped reading has had [`events::FINAL_WAIT`]).
fn stopped(json: bool, reason: &str) {
    if json {
        Event::Stopped { reason }.print();
    } else {
        events::out(
            format!(
                "\n  {} The share stopped: {}.",
                dim("●"),
                sanitize_line(reason)
            ),
            false,
        );
    }
    events::flush(events::FINAL_WAIT);
}

/// Shows what the session said. It runs on the session's own loop, so it
/// only queues the text (see [`events::out`]): a stdout nobody reads never
/// holds up visitors.
fn show_share_update(update: Update, local: &str, json: bool, qr: bool) {
    if json {
        share_event(&update).print();
    } else {
        let (text, droppable) = share_text(update, local, qr);
        events::out(text, droppable);
    }
}

/// The `--json` line for an update.
fn share_event(update: &Update) -> Event<'_> {
    match update {
        Update::Ready {
            name,
            url,
            expires_at,
            notice,
            password,
            ..
        } => Event::Live {
            url,
            name,
            expires_at: expires_at.as_deref(),
            notice: *notice,
            password: *password,
        },
        Update::Reconnected => Event::Reconnected,
        Update::Request {
            method,
            path,
            status,
            ms,
            ..
        } => Event::Request {
            method,
            path,
            status: *status,
            ms: *ms,
        },
        Update::Notice(text) => Event::Notice { text },
        Update::Retrying { message, seconds } => Event::Retrying {
            message,
            seconds: *seconds,
        },
    }
}

/// The text a person reads for an update, and whether it may be dropped
/// when the reader falls behind (a visitor's request line may).
fn share_text(update: Update, local: &str, qr: bool) -> (String, bool) {
    let line = |text: String| (text, false);
    match update {
        Update::Ready {
            url,
            expires_in,
            notice,
            password,
            ..
        } => {
            let mut lines = vec![
                format!("\n  {} Sharing", green("●")),
                format!("  {} {}", dim("Link:         "), bold(&sanitize_line(&url))),
                format!("  {} {local}", dim("Forwarding to:")),
            ];
            if let Some(seconds) = expires_in {
                lines.push(format!(
                    "  {}",
                    dim(&format!(
                        "It stops in {}, the longest a share runs on your plan.",
                        duration(seconds)
                    ))
                ));
            }
            if notice {
                lines.push(format!(
                    "  {}",
                    dim("Visitors see a short notice from webhooks.cc before your page.")
                ));
            }
            if password {
                lines.push(format!(
                    "  {}",
                    dim("Visitors need the password to open it.")
                ));
            }
            if qr && let Some(code) = share::qr::text(&url) {
                lines.push(String::new());
                lines.push(code);
            }
            lines.push(format!("  {}\n", dim("Press Ctrl+C to stop.")));
            line(lines.join("\n"))
        }
        Update::Reconnected => line(format!("  {} {}", green("●"), dim("Reconnected"))),
        Update::Request {
            method,
            path,
            status,
            ms,
            ..
        } => (request_line(&method, &path, status, ms), true),
        Update::Notice(text) => line(format!("  {} {}", dim("●"), sanitize(&text))),
        Update::Retrying { message, seconds } => line(format!(
            "  {} {}",
            dim("●"),
            dim(&format!(
                "{} Trying again in {seconds}s.",
                sanitize_line(&message)
            ))
        )),
    }
}

/// One line for a visitor request, or a relayed capture.
pub fn request_line(method: &str, path: &str, status: u16, ms: u64) -> String {
    let time = chrono::Local::now().format("%H:%M:%S").to_string();
    let status_text = if status < 400 {
        green(&status.to_string())
    } else {
        crate::cli::output::red(&status.to_string())
    };
    format!(
        "  {} {} {} -> {} {}",
        dim(&time),
        crate::cli::output::method_color(&printable(method, 10)),
        printable(path, 160),
        status_text,
        dim(&format!("{ms} ms"))
    )
}

/// "512 B", "3.4 MB", "1.2 GB".
pub fn data(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.2} GB", b / (KB * KB * KB))
    }
}

fn usage_line(usage: &TunnelUsage) -> String {
    let limit = usage
        .limit_bytes
        .map(|l| format!(" of {}", data(l)))
        .unwrap_or_default();
    let month = usage.month.as_deref().unwrap_or("this month");
    let mut line = format!("Data {month}: {}{limit}", data(usage.bytes));
    if usage.over {
        let resets = usage
            .resets_at
            .as_ref()
            .map(|t| format!(" until {}", t.display()))
            .unwrap_or_default();
        line.push_str(&format!(" (over: previews are paused{resets})"));
    }
    line
}

fn share_label(share: &Share) -> String {
    match share.kind.as_str() {
        "live" => format!(
            "live {}",
            share
                .endpoint_slug
                .as_deref()
                .or(share.name.as_deref())
                .unwrap_or("-")
        ),
        _ => share.name.clone().unwrap_or_else(|| "-".to_string()),
    }
}

/// `whk shares ls`: the shares, this month's data, the plan's limits and,
/// for live shares, the names that can be shared under: everything the
/// Shares page shows, so nothing needs the dashboard.
pub async fn list(client: &ApiClient, ended: bool, json: bool) -> Result<()> {
    let result = client.list_shares(ended).await?;
    // Names are a second call; a failure there never hides the shares.
    let names = if ended {
        None
    } else {
        client.list_names().await.ok()
    };
    if json {
        // Everything the API sent, as it sent it, and the names one may
        // share under beside it (`nameList`, the GET /api/tunnel-names
        // answer; `names` stays the API's own summary).
        let mut value = serde_json::to_value(&result)?;
        if let (Some(names), Some(object)) = (&names, value.as_object_mut()) {
            object.insert("nameList".to_string(), serde_json::to_value(names)?);
        }
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    if result.suspended {
        println!(
            "  {} Sharing is suspended on this account.",
            crate::cli::output::red("●")
        );
    }
    if let Some(message) = result.usage.as_ref().and_then(|u| u.message.as_deref()) {
        println!("  {} {}", dim("●"), sanitize_line(message));
    }
    print_shares(&result, ended);
    if let Some(limits) = &result.limits {
        let live = result.shares.iter().filter(|s| s.kind != "live").count();
        println!("  {}", dim(&limits_line(limits, live)));
    }
    if let Some(names) = &names
        && let Some(line) = names_line(names)
    {
        println!("  {}", dim(&line));
    }
    for hint in &result.hints {
        println!("  {}", dim(&sanitize_line(hint)));
    }
    Ok(())
}

/// "Plan pro: 2 of 3 shares at once, no time limit, 25 GB a month,
/// passwords on, no visitor notice."
pub fn limits_line(limits: &TunnelLimits, live: usize) -> String {
    let plan = limits.plan.as_deref().unwrap_or("your plan");
    let mut parts = Vec::new();
    if let Some(shares) = limits.shares {
        let noun = if shares == 1 { "share" } else { "shares" };
        parts.push(format!("{live} of {shares} {noun} at once"));
    }
    parts.push(match limits.session_minutes {
        Some(minutes) if minutes % 60 == 0 => format!("{} h a share", minutes / 60),
        Some(minutes) => format!("{minutes} min a share"),
        None => "no time limit".to_string(),
    });
    if let Some(gb) = limits.data_gb {
        parts.push(format!("{gb} GB a month"));
    }
    parts.push(if limits.passwords {
        "passwords on".to_string()
    } else {
        "no passwords".to_string()
    });
    parts.push(if limits.notice {
        "visitors see a notice first".to_string()
    } else {
        "no visitor notice".to_string()
    });
    format!("Plan {plan}: {}.", parts.join(", "))
}

/// "Names: acme, beta (2 of 3; whk names ls)", or None with none to use.
fn names_line(names: &NamesResponse) -> Option<String> {
    let usable: Vec<&str> = names
        .names
        .iter()
        .filter(|n| n.usable)
        .map(|n| n.name.as_str())
        .collect();
    if usable.is_empty() {
        return None;
    }
    let count = match (names.used, names.limit) {
        (Some(used), Some(limit)) if limit > 0 => format!("{used} of {limit}; "),
        _ => String::new(),
    };
    Some(format!(
        "Names to share under: {} ({count}whk share 3000 --name <name>)",
        sanitize_line(&usable.join(", "))
    ))
}

fn print_shares(result: &SharesResponse, ended: bool) {
    if result.shares.is_empty() {
        if ended {
            println!("  No earlier shares.");
        } else {
            println!(
                "  Nothing is shared right now. Start with {}",
                bold("whk share 3000")
            );
        }
    } else {
        println!(
            "  {}",
            dim(&format!(
                "{:<28} {:<44} {:<17} {:>9} {:>8}  {}",
                "NAME", "LINK", "STARTED", "DATA", "REQUESTS", "ID"
            ))
        );
        for share in &result.shares {
            let mut name = sanitize_line(&share_label(share));
            if share.password {
                name.push_str(" (password)");
            }
            if !share.mine
                && let Some(by) = &share.started_by
            {
                name.push_str(&format!(" ({})", sanitize_line(&by.label())));
            }
            let started = share
                .started_at
                .as_ref()
                .map(|t| t.display())
                .unwrap_or_else(|| "-".to_string());
            println!(
                "  {:<28} {:<44} {:<17} {:>9} {:>8}  {}",
                bold(&name),
                sanitize_line(share.url.as_deref().unwrap_or("-")),
                started,
                data(share.bytes),
                share.requests,
                dim(&share.id),
            );
            if ended && let Some(reason) = &share.end_reason {
                println!("    {}", dim(&format!("ended: {}", sanitize_line(reason))));
            }
        }
    }
    if let Some(usage) = &result.usage {
        println!("\n  {}", dim(&usage_line(usage)));
    }
}

/// Picks a live share by id, or by name (or a live session's endpoint slug).
pub fn resolve_share<'a>(shares: &'a [Share], needle: &str) -> Result<&'a Share> {
    let needle = needle.trim();
    if let Some(share) = shares.iter().find(|s| s.id == needle) {
        return Ok(share);
    }
    let by_name: Vec<&Share> = shares
        .iter()
        .filter(|s| s.name.as_deref() == Some(needle) || s.endpoint_slug.as_deref() == Some(needle))
        .collect();
    match by_name.as_slice() {
        [share] => Ok(share),
        [] => bail!("No live share named or with id {needle:?}. See `whk shares ls`."),
        many => bail!(
            "{} live shares match {needle:?}; give the id instead ({})",
            many.len(),
            many.iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// How long after its tunnel dropped a run can still be stopped for good:
/// the server gives a stop to a run that dropped in the last 5 minutes, so a
/// CLI reconnecting then is refused.
const RECONNECT_GAP: chrono::Duration = chrono::Duration::minutes(5);

/// An ended run that is only waiting to reconnect: it dropped (no reason
/// recorded, which is how the API shows a dropped tunnel) or the edge
/// restarted, within [`RECONNECT_GAP`]. Final endings (stopped, time limit,
/// plan changed...) carry their reason and are left alone.
fn reconnecting(share: &Share, now: chrono::DateTime<chrono::Utc>) -> bool {
    let dropped = match share.end_reason.as_deref() {
        None => true,
        Some(reason) => reason.starts_with("webhooks.cc restarted"),
    };
    let recent = share
        .ended_at
        .as_ref()
        .and_then(|t| t.utc())
        .is_some_and(|ended| now - ended <= RECONNECT_GAP);
    share.mine && dropped && recent
}

/// The run `whk shares stop` means when it is not in the live list because
/// its CLI is reconnecting: the most recent such run with that id, name or
/// live endpoint.
pub fn resolve_reconnecting<'a>(
    ended: &'a [Share],
    needle: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<&'a Share> {
    let needle = needle.trim();
    ended
        .iter()
        .filter(|s| {
            s.id == needle
                || s.name.as_deref() == Some(needle)
                || s.endpoint_slug.as_deref() == Some(needle)
        })
        .filter(|s| reconnecting(s, now))
        .max_by_key(|s| s.ended_at.as_ref().and_then(|t| t.utc()))
}

/// `whk shares stop <id|name>`. A share whose CLI is reconnecting is not in
/// the live list; the stop goes to its last run, which the server makes
/// stick, so the reconnect is refused.
pub async fn stop(client: &ApiClient, needle: &str, json: bool) -> Result<()> {
    let live = client.list_shares(false).await?;
    let found = resolve_share(&live.shares, needle);
    let ended;
    let share = match found {
        Ok(share) => share,
        Err(err) if err.to_string().starts_with("No live share") => {
            ended = client.list_shares(true).await?;
            match resolve_reconnecting(&ended.shares, needle, chrono::Utc::now()) {
                Some(share) => share,
                None => return Err(err),
            }
        }
        Err(err) => return Err(err),
    };
    client.stop_share(&share.id).await?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "stopped": true, "id": share.id, "name": share.name })
        );
    } else {
        println!(
            "{} Stopped {}",
            green("✓"),
            bold(&sanitize_line(&share_label(share)))
        );
    }
    Ok(())
}

/// `whk shares log <id|name>`: the last requests visitors made to a live
/// share, newest first, from the edge's memory (no addresses).
pub async fn log(client: &ApiClient, needle: &str, json: bool) -> Result<()> {
    let live = client.list_shares(false).await?;
    let share = resolve_share(&live.shares, needle)?;
    let result = client.share_requests(&share.id).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    print_log(&result);
    Ok(())
}

fn print_log(result: &ShareRequestsResponse) {
    if !result.available {
        println!("  The request log can't be read just now. Try again in a moment.");
        return;
    }
    if result.requests.is_empty() {
        println!("  No visitors yet.");
        return;
    }
    println!(
        "  {}",
        dim(&format!(
            "{:<17} {:<7} {:<40} {:>6} {:>7} {:>9}  {}",
            "TIME", "METHOD", "PATH", "STATUS", "MS", "DATA", "VISITOR"
        ))
    );
    for r in &result.requests {
        let visitor = match &r.visitor {
            Some(serde_json::Value::Number(n)) => format!("#{n}"),
            Some(serde_json::Value::String(s)) => sanitize_line(s),
            _ => "-".to_string(),
        };
        let place = [r.device.as_deref(), r.country.as_deref()]
            .into_iter()
            .flatten()
            .map(sanitize_line)
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "  {:<17} {:<7} {:<40} {:>6} {:>7} {:>9}  {}{}",
            r.at.as_ref().map(|t| t.display()).unwrap_or_default(),
            printable(&r.method, 7),
            printable(&r.path, 40),
            r.status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "-".into()),
            r.ms.map(|m| m.to_string()).unwrap_or_else(|| "-".into()),
            r.bytes.map(data).unwrap_or_else(|| "-".into()),
            visitor,
            if place.is_empty() {
                String::new()
            } else {
                format!(" ({place})")
            },
        );
    }
}

/// `whk names ls`.
pub async fn names(client: &ApiClient, json: bool) -> Result<()> {
    let result = client.list_names().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if result.names.is_empty() {
        if result.limit == Some(0) {
            println!("  Reserved names come with Pro and Business. Free shares get a random name.");
        } else {
            println!(
                "  No names yet. Keep one with {}",
                bold("whk names reserve <name>")
            );
        }
    } else {
        println!(
            "  {}",
            dim(&format!(
                "{:<28} {:<44} {:<20} {}",
                "NAME", "LINK", "TEAM", "NOTES"
            ))
        );
        for name in &result.names {
            println!(
                "  {:<28} {:<44} {:<20} {}",
                bold(&sanitize_line(&name.name)),
                sanitize_line(name.url.as_deref().unwrap_or("-")),
                sanitize_line(
                    name.team
                        .as_ref()
                        .and_then(|t| t.name.as_deref())
                        .unwrap_or("-")
                ),
                dim(&name_notes(name)),
            );
        }
    }
    if let (Some(used), Some(limit)) = (result.used, result.limit)
        && limit > 0
    {
        println!(
            "\n  {}",
            dim(&format!("{used} of {limit} names on your plan"))
        );
    }
    for team in &result.teams {
        if let (Some(used), Some(limit)) = (team.used, team.limit) {
            let lapsed = if team.active {
                ""
            } else {
                " (no subscription: its names wait until it subscribes again)"
            };
            println!(
                "  {}",
                dim(&format!(
                    "{used} of {limit} names in team {}{lapsed}",
                    sanitize_line(team.name.as_deref().or(team.id.as_deref()).unwrap_or("-"))
                ))
            );
        }
    }
    Ok(())
}

fn name_notes(name: &TunnelName) -> String {
    let mut notes = Vec::new();
    if !name.usable {
        notes.push("not usable on your plan".to_string());
    }
    if name.live {
        notes.push("live now".to_string());
    }
    if name.password {
        notes.push("password".to_string());
    }
    if !name.mine
        && let Some(by) = &name.reserved_by
    {
        notes.push(format!("kept by {}", sanitize_line(&by.label())));
    }
    notes.join(", ")
}

/// `whk names reserve <name> [--team <id|name>]`.
pub async fn reserve(client: &ApiClient, name: &str, team: Option<&str>, json: bool) -> Result<()> {
    let team_id = match team {
        Some(team) => Some(team_id(client, team).await?),
        None => None,
    };
    let reserved = client.reserve_name(name, team_id.as_deref()).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&reserved)?);
    } else {
        let url = reserved.name.url.as_deref().unwrap_or("");
        println!(
            "{} Reserved {} {}",
            green("✓"),
            bold(&sanitize_line(&reserved.name.name)),
            dim(&sanitize_line(url))
        );
        println!(
            "  {}",
            dim(&format!(
                "Share under it: whk share 3000 --name {}",
                reserved.name.name
            ))
        );
    }
    Ok(())
}

/// A team named by id or by name (case does not matter), from the
/// account's teams.
async fn team_id(client: &ApiClient, wanted: &str) -> Result<String> {
    let teams = client.list_teams().await?;
    if let Some(team) = teams.iter().find(|t| t.id == wanted) {
        return Ok(team.id.clone());
    }
    let matches: Vec<_> = teams
        .iter()
        .filter(|t| t.name.eq_ignore_ascii_case(wanted.trim()))
        .collect();
    match matches.as_slice() {
        [team] => Ok(team.id.clone()),
        [] => bail!("You are in no team named {wanted:?}. See `whk teams list`."),
        many => bail!(
            "{} teams are named {wanted:?}; give the id instead ({})",
            many.len(),
            many.iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// `whk names release <name>`.
pub async fn release(client: &ApiClient, name: &str, json: bool) -> Result<()> {
    client.release_name(name).await?;
    if json {
        println!("{}", serde_json::json!({ "released": true, "name": name }));
    } else {
        println!("{} Released {}", green("✓"), bold(&sanitize_line(name)));
    }
    Ok(())
}

/// `whk names password <name> [--clear]`: the password visitors need for
/// every share under the name.
pub async fn password(client: &ApiClient, name: &str, clear: bool, json: bool) -> Result<()> {
    let password = if clear {
        None
    } else {
        Some(share::read_password()?)
    };
    let result = client.set_name_password(name, password.as_deref()).await?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "name": name, "password": result.password })
        );
    } else if result.password {
        println!(
            "{} Visitors to {} now need the password.",
            green("✓"),
            bold(&sanitize_line(name))
        );
    } else {
        println!(
            "{} {} no longer needs a password.",
            green("✓"),
            bold(&sanitize_line(name))
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn share(id: &str, name: &str) -> Share {
        serde_json::from_value(serde_json::json!({ "id": id, "name": name })).unwrap()
    }

    #[test]
    fn the_share_list_keeps_everything_the_api_sent() {
        let api = serde_json::json!({
            "shares": [{ "id": "sh_1", "name": "acme", "notice": true, "startedBy": null, "future": 1 }],
            "usage": { "month": "2026-11", "bytes": 5, "limitBytes": 10, "over": true,
                       "resetsAt": "2026-12-01T00:00:00Z", "message": "Paused until 1 December." },
            "limits": { "plan": "free", "label": "Free", "shares": 1, "reservedNames": 0,
                        "sessionMinutes": 120, "dataGb": 1, "passwords": false, "notice": true },
            "names": { "limit": 0, "used": 0, "usable": 0 },
            "suspended": true,
            "hints": ["Stop one with whk shares stop <id or name>."],
            "somethingNew": { "a": 1 }
        });
        let parsed: SharesResponse = serde_json::from_value(api.clone()).unwrap();
        assert!(parsed.suspended);
        assert_eq!(parsed.hints.len(), 1);
        assert_eq!(
            parsed.usage.as_ref().unwrap().message.as_deref(),
            Some("Paused until 1 December.")
        );
        assert_eq!(
            parsed.limits.as_ref().unwrap().label.as_deref(),
            Some("Free")
        );
        let back = serde_json::to_value(&parsed).unwrap();
        for key in ["suspended", "hints", "names", "somethingNew"] {
            assert_eq!(back[key], api[key], "{key}");
        }
        assert_eq!(back["usage"]["message"], api["usage"]["message"]);
        assert_eq!(back["limits"]["label"], api["limits"]["label"]);
        assert_eq!(back["shares"][0]["notice"], true);
        assert_eq!(back["shares"][0]["future"], 1);
    }

    #[test]
    fn data_reads_in_the_right_unit() {
        assert_eq!(data(512), "512 B");
        assert_eq!(data(2048), "2.0 KB");
        assert_eq!(data(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(data(3 * 1024 * 1024 * 1024 / 2), "1.50 GB");
    }

    #[test]
    fn a_share_is_found_by_id_or_name() {
        let shares = vec![share("sh_1", "acme"), share("sh_2", "beta")];
        assert_eq!(resolve_share(&shares, "sh_2").unwrap().id, "sh_2");
        assert_eq!(resolve_share(&shares, "acme").unwrap().id, "sh_1");
        assert!(resolve_share(&shares, "gamma").is_err());
        let twice = vec![share("sh_1", "acme"), share("sh_3", "acme")];
        assert!(resolve_share(&twice, "acme").is_err());
    }

    fn ended(id: &str, name: &str, ago_secs: i64, reason: Option<&str>) -> Share {
        let at = chrono::Utc::now() - chrono::Duration::seconds(ago_secs);
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "endedAt": at.to_rfc3339(), "endReason": reason
        }))
        .unwrap()
    }

    #[test]
    fn a_share_reconnecting_is_found_among_recently_ended_runs() {
        let now = chrono::Utc::now();
        let runs = vec![
            ended("sh_old", "acme", 600, None),
            ended("sh_drop", "acme", 30, None),
            ended(
                "sh_restart",
                "beta",
                60,
                Some("webhooks.cc restarted and the CLI did not reconnect"),
            ),
            ended(
                "sh_final",
                "gamma",
                10,
                Some("you stopped it (whk shares stop, the Shares page or the API)"),
            ),
        ];
        assert_eq!(
            resolve_reconnecting(&runs, "acme", now).unwrap().id,
            "sh_drop"
        );
        assert_eq!(
            resolve_reconnecting(&runs, "sh_drop", now).unwrap().id,
            "sh_drop"
        );
        assert_eq!(
            resolve_reconnecting(&runs, "beta", now).unwrap().id,
            "sh_restart"
        );
        // Stopped for good, or dropped too long ago: nothing to stop.
        assert!(resolve_reconnecting(&runs, "gamma", now).is_none());
        assert!(resolve_reconnecting(&runs, "sh_old", now).is_none());
        assert!(resolve_reconnecting(&runs, "delta", now).is_none());
    }

    #[tokio::test]
    async fn stop_reaches_a_share_whose_cli_is_reconnecting() {
        use axum::{
            Json, Router,
            extract::{Path, Query},
            routing::{get, post},
        };
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        let stopped: Arc<Mutex<Vec<String>>> = Arc::default();
        let at = (chrono::Utc::now() - chrono::Duration::seconds(20)).to_rfc3339();
        let seen = stopped.clone();
        let app = Router::new()
            .route(
                "/api/shares",
                get(move |Query(q): Query<HashMap<String, String>>| {
                    let at = at.clone();
                    async move {
                        if q.get("state").map(String::as_str) == Some("ended") {
                            Json(serde_json::json!({ "shares": [
                                { "id": "sh_gap", "name": "acme-demo", "endedAt": at, "endReason": null }
                            ]}))
                        } else {
                            Json(serde_json::json!({ "shares": [] }))
                        }
                    }
                }),
            )
            .route(
                "/api/shares/{id}/stop",
                post(move |Path(id): Path<String>| {
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push(id);
                        Json(serde_json::json!({ "ok": true, "stopped": 1, "edgeReached": true }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client =
            ApiClient::with_credentials(Some(&base), Some(&base), Some("whcc_test".into()), None)
                .unwrap();
        stop(&client, "acme-demo", true).await.unwrap();
        assert_eq!(*stopped.lock().unwrap(), vec!["sh_gap".to_string()]);
        // A name that matches nothing keeps the usual message.
        let err = stop(&client, "nothing-here", true).await.unwrap_err();
        assert!(err.to_string().starts_with("No live share"), "{err}");
    }

    #[test]
    fn a_live_session_is_found_by_its_endpoint() {
        let live: Share = serde_json::from_value(serde_json::json!({
            "id": "sh_9", "kind": "live", "endpointSlug": "abc123"
        }))
        .unwrap();
        assert_eq!(
            resolve_share(std::slice::from_ref(&live), "abc123")
                .unwrap()
                .id,
            "sh_9"
        );
        assert_eq!(share_label(&live), "live abc123");
    }

    #[test]
    fn usage_says_when_previews_are_paused() {
        let usage: TunnelUsage = serde_json::from_value(serde_json::json!({
            "month": "2026-11", "bytes": 2048, "limitBytes": 1073741824, "over": true
        }))
        .unwrap();
        let line = usage_line(&usage);
        assert!(
            line.starts_with("Data 2026-11: 2.0 KB of 1.00 GB"),
            "{line}"
        );
        assert!(line.contains("paused"));
    }

    #[test]
    fn limits_read_like_the_shares_page() {
        let free: TunnelLimits = serde_json::from_value(serde_json::json!({
            "plan": "free", "shares": 1, "reservedNames": 0, "sessionMinutes": 120,
            "dataGb": 1, "passwords": false, "notice": true
        }))
        .unwrap();
        assert_eq!(
            limits_line(&free, 1),
            "Plan free: 1 of 1 share at once, 2 h a share, 1 GB a month, no passwords, visitors see a notice first."
        );
        let pro: TunnelLimits = serde_json::from_value(serde_json::json!({
            "plan": "pro", "shares": 3, "sessionMinutes": null, "dataGb": 25,
            "passwords": true, "notice": false
        }))
        .unwrap();
        assert_eq!(
            limits_line(&pro, 0),
            "Plan pro: 0 of 3 shares at once, no time limit, 25 GB a month, passwords on, no visitor notice."
        );
    }

    #[test]
    fn only_usable_names_are_offered() {
        let names: NamesResponse = serde_json::from_value(serde_json::json!({
            "names": [
                {"name": "acme", "usable": true},
                {"name": "old", "usable": false},
                {"name": "beta"}
            ],
            "limit": 3, "used": 3,
            "teams": [{"id": "t1", "name": "Acme", "limit": 6, "used": 1}]
        }))
        .unwrap();
        let line = names_line(&names).unwrap();
        assert!(line.contains("acme, beta"), "{line}");
        assert!(!line.contains("old"), "{line}");
        assert!(line.contains("3 of 3"), "{line}");
        assert_eq!(names.teams[0].limit, Some(6));
        assert!(name_notes(&names.names[1]).contains("not usable"));
        let none: NamesResponse =
            serde_json::from_value(serde_json::json!({"names": [], "limit": 0})).unwrap();
        assert!(names_line(&none).is_none());
    }

    #[test]
    fn the_request_log_parses_the_api_shape() {
        let log: ShareRequestsResponse = serde_json::from_value(serde_json::json!({
            "available": true,
            "requests": [{"method": "GET", "path": "/", "status": 200, "ms": 4, "bytes": 512,
                "at": "2026-11-10T12:00:00.000Z", "country": "DK", "device": "phone", "visitor": 1}]
        }))
        .unwrap();
        assert!(log.available);
        assert_eq!(log.requests[0].status, Some(200));
        let older: ShareRequestsResponse =
            serde_json::from_value(serde_json::json!({"requests": []})).unwrap();
        assert!(
            older.available,
            "an older server without the flag reads as available"
        );
    }

    #[test]
    fn only_a_visitors_request_line_may_be_dropped() {
        let ready = Update::Ready {
            name: "acme".into(),
            url: "https://acme.sharehooks.cc".into(),
            expires_at: None,
            expires_in: Some(7200),
            notice: true,
            password: false,
        };
        let (text, droppable) = share_text(ready, "localhost:3000", false);
        assert!(!droppable);
        assert!(text.contains("https://acme.sharehooks.cc"), "{text}");
        assert!(text.contains("It stops in 2 h"), "{text}");
        let request = Update::Request {
            method: "GET".into(),
            path: "/".into(),
            status: 200,
            ms: 4,
            request_id: None,
        };
        assert!(share_text(request.clone(), "localhost:3000", false).1);
        assert_eq!(
            share_event(&request).line(),
            r#"{"event":"request","method":"GET","path":"/","status":200,"ms":4}"#
        );
        let retrying = Update::Retrying {
            message: "The connection dropped.".into(),
            seconds: 2,
        };
        assert!(!share_text(retrying, "localhost:3000", false).1);
    }
}
