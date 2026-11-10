//! `whk share`, `whk shares` and `whk names`: share a local port at a link
//! on sharehooks.cc, see and stop shares, and keep names to share under.

use std::io::IsTerminal;

use anyhow::{Result, bail};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize, sanitize_line};
use crate::share::events::Event;
use crate::share::{self, Kind, Session, Update, duration, printable};
use crate::types::{Share, SharesResponse, TunnelName, TunnelUsage};

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
        std::process::exit(1);
    }
    result
}

async fn run_inner(client: &ApiClient, options: ShareOptions) -> Result<()> {
    client.require_auth()?;
    let port = share::parse_share_target(&options.target)?;
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
        port,
        rewrite: None,
        client: share::client_name(),
    };
    let json = options.json;
    let qr = !json && !options.no_qr && share::qr::wanted(std::io::stdout().is_terminal());

    if options.until_stdin_closes {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            stopped(json, "the program that started it ended");
            std::process::exit(0);
        });
    }

    let mut show = |update: Update| show_share_update(update, port, json, qr);
    tokio::select! {
        result = share::run(&session, &mut show) => {
            let reason = result?;
            stopped(json, &reason);
        }
        _ = tokio::signal::ctrl_c() => stopped(json, "you stopped it on this computer"),
    }
    Ok(())
}

/// The last line of a share. Written without println!, which panics when
/// nobody reads stdout any more.
fn stopped(json: bool, reason: &str) {
    use std::io::Write;
    if json {
        Event::Stopped { reason }.print();
    } else {
        let _ = writeln!(
            std::io::stdout(),
            "\n  {} The share stopped: {}.",
            dim("●"),
            sanitize_line(reason)
        );
    }
}

fn show_share_update(update: Update, port: u16, json: bool, qr: bool) {
    match update {
        Update::Ready {
            name,
            url,
            expires_at,
            expires_in,
            notice,
            password,
        } => {
            if json {
                Event::Live {
                    url: &url,
                    name: &name,
                    expires_at: expires_at.as_deref(),
                    notice,
                    password,
                }
                .print();
                return;
            }
            println!("\n  {} Sharing", green("●"));
            println!("  {} {}", dim("Link:         "), bold(&sanitize_line(&url)));
            println!("  {} localhost:{port}", dim("Forwarding to:"));
            if let Some(seconds) = expires_in {
                println!(
                    "  {}",
                    dim(&format!(
                        "It stops in {}, the longest a share runs on your plan.",
                        duration(seconds)
                    ))
                );
            }
            if notice {
                println!(
                    "  {}",
                    dim("Visitors see a short notice from webhooks.cc before your page.")
                );
            }
            if password {
                println!("  {}", dim("Visitors need the password to open it."));
            }
            if qr {
                println!();
                share::qr::print(&url);
            }
            println!("  {}\n", dim("Press Ctrl+C to stop."));
        }
        Update::Reconnected => {
            if json {
                Event::Reconnected.print();
            } else {
                println!("  {} {}", green("●"), dim("Reconnected"));
            }
        }
        Update::Request {
            method,
            path,
            status,
            ms,
        } => {
            if json {
                Event::Request {
                    method: &method,
                    path: &path,
                    status,
                    ms,
                }
                .print();
            } else {
                println!("{}", request_line(&method, &path, status, ms));
            }
        }
        Update::Notice(text) => {
            if json {
                Event::Notice { text: &text }.print();
            } else {
                println!("  {} {}", dim("●"), sanitize(&text));
            }
        }
        Update::Retrying { message, seconds } => {
            if json {
                Event::Retrying {
                    message: &message,
                    seconds,
                }
                .print();
            } else {
                println!(
                    "  {} {}",
                    dim("●"),
                    dim(&format!(
                        "{} Trying again in {seconds}s.",
                        sanitize_line(&message)
                    ))
                );
            }
        }
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

/// `whk shares ls`.
pub async fn list(client: &ApiClient, ended: bool, json: bool) -> Result<()> {
    let result = client.list_shares(ended).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    print_shares(&result, ended);
    Ok(())
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

/// `whk shares stop <id|name>`.
pub async fn stop(client: &ApiClient, needle: &str, json: bool) -> Result<()> {
    let live = client.list_shares(false).await?;
    let share = resolve_share(&live.shares, needle)?;
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

/// `whk names ls`.
pub async fn names(client: &ApiClient, json: bool) -> Result<()> {
    let result = client.list_names().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if result.names.is_empty() {
        println!(
            "  No names yet. Keep one with {}",
            bold("whk names reserve <name>")
        );
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
    if let (Some(used), Some(limit)) = (result.used, result.limit) {
        println!(
            "\n  {}",
            dim(&format!("{used} of {limit} names on your plan"))
        );
    }
    Ok(())
}

fn name_notes(name: &TunnelName) -> String {
    let mut notes = Vec::new();
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

/// `whk names reserve <name>`.
pub async fn reserve(client: &ApiClient, name: &str, json: bool) -> Result<()> {
    let reserved = client.reserve_name(name).await?;
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
}
