use anyhow::Result;
use std::time::Duration;

use crate::agent::CredentialStore;
use crate::api::{ApiClient, AuthSource};
use crate::auth;
use crate::cli::output::{bold, dim, green, red};
use crate::error::CliError;
use crate::types::Token;

/// Whether this machine is not the one with the person's browser: an SSH
/// session, or Linux with no display (a server, a container). The link is
/// then printed to be opened elsewhere, and no browser is started here.
/// WSL counts as local even without a display: `open` reaches the Windows
/// browser through wslview. A shell that only inherited `SSH_CONNECTION`
/// (tmux started over SSH, attached locally) still counts as remote; the
/// link is printed either way.
pub fn remote_session(env: impl Fn(&str) -> Option<String>) -> bool {
    let set = |name: &str| env(name).is_some_and(|v| !v.trim().is_empty());
    if set("SSH_CONNECTION") || set("SSH_TTY") || set("SSH_CLIENT") {
        return true;
    }
    let wsl = set("WSL_DISTRO_NAME") || set("WSL_INTEROP");
    cfg!(target_os = "linux") && !wsl && !set("DISPLAY") && !set("WAYLAND_DISPLAY")
}

pub async fn login(
    client: &mut ApiClient,
    json: bool,
    remote_flag: bool,
    no_browser: bool,
) -> Result<()> {
    if auth::is_logged_in() {
        let token = auth::load_token()?.unwrap();
        if json {
            println!(
                "{}",
                serde_json::json!({ "status": "already_logged_in", "email": token.email })
            );
        } else {
            println!("Already logged in as {}", bold(&token.email));
            println!("{}", dim("Run `whk auth logout` first to switch accounts."));
        }
        return Ok(());
    }

    let remote = remote_flag || remote_session(|name| std::env::var(name).ok());

    // Step 1: Create device code
    let device = client.create_device_code(remote).await?;
    // The page with the code in it, so the person compares the code rather
    // than typing it; older servers only send the bare page.
    let link = device
        .verification_url_complete
        .clone()
        .unwrap_or_else(|| device.verification_url.clone());

    if json {
        // One line per step (NDJSON), so an agent can show the human the
        // link while this keeps polling.
        println!(
            "{}",
            serde_json::json!({
                "status": "pending",
                "user_code": device.user_code,
                "verification_url": device.verification_url,
                "verification_url_complete": device.verification_url_complete,
                "remote": remote,
                "expires_at": device.expires_at,
                "message": if device.verification_url_complete.is_some() {
                    "Open verification_url_complete in a browser signed in to webhooks.cc, check that the page shows user_code, and approve."
                } else {
                    "Open verification_url in a browser signed in to webhooks.cc, enter user_code, and approve."
                },
            })
        );
    } else {
        println!("\n  Open this link to approve the login:\n");
        println!("    {}\n", bold(&link));
        println!(
            "  The page shows the code {}: approve only if it matches.",
            green(&device.user_code)
        );
        if remote {
            println!(
                "  {}",
                dim("This looks like another machine: open the link in your own browser.")
            );
        }
    }

    // Open the browser only on this machine's own desktop, and only for a
    // link that looks right.
    if !json && !remote && !no_browser && link.starts_with("https://") {
        let _ = open::that(&link);
    }

    if !json {
        println!("\n  Waiting for approval...");
    }

    // Step 2: Poll until authorized or expired
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        let poll = client.poll_device_code(&device.device_code).await?;
        match poll.status.as_str() {
            "authorized" => break,
            "denied" => return Err(CliError::LoginDenied.into()),
            "expired" => return Err(CliError::LoginExpired.into()),
            _ => continue, // "pending"
        }
    }

    // Step 3: Claim the device code
    let claim = client.claim_device_code(&device.device_code).await?;

    let token = Token {
        access_token: claim.api_key.clone(),
        user_id: claim.user_id.clone(),
        email: claim.email.clone(),
    };

    auth::save_token(&token)?;
    client.set_token(claim.api_key);

    if json {
        println!(
            "{}",
            serde_json::json!({ "status": "success", "email": claim.email })
        );
    } else {
        println!(
            "\n  {} Logged in as {}",
            green("Success!"),
            bold(&claim.email)
        );
    }

    Ok(())
}

pub async fn status(client: &ApiClient, json: bool) -> Result<()> {
    // WHK_AUTH=key: the key in WHK_API_KEY acts, whatever the saved login.
    if matches!(client.auth_source(), AuthSource::EnvKey) {
        if json {
            println!(
                "{}",
                serde_json::json!({ "logged_in": true, "via": "api_key_env" })
            );
        } else {
            println!(
                "  {} Using the API key in {} ({})",
                green("●"),
                bold("WHK_API_KEY"),
                dim("WHK_AUTH=key")
            );
            println!(
                "  {}",
                dim("Unset WHK_AUTH to use this machine's login (whk auth login) instead.")
            );
        }
        return Ok(());
    }
    match auth::load_token()? {
        Some(token) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "logged_in": true,
                        "via": "login",
                        "email": token.email,
                        "user_id": token.user_id,
                    })
                );
            } else {
                println!("  {} Logged in as {}", green("●"), bold(&token.email));
            }
        }
        None => match client.auth_source() {
            // No login, but an agent's account connection in the shared
            // credential file: the commands act through it.
            AuthSource::Agent(session) => {
                let slot = session.slot().await;
                let email = slot
                    .as_ref()
                    .and_then(|s| s.info("email").map(String::from));
                let expires = slot.as_ref().map(|s| s.assertion_expires().to_string());
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "logged_in": true,
                            "via": "agent",
                            "email": email,
                            "registration_id": session.registration_id(),
                            "connection_expires": expires,
                            "credential_file": session.store().path().map(|p| p.display().to_string()),
                        })
                    );
                } else {
                    println!(
                        "  {} Acting through an agent connection to {}",
                        green("●"),
                        bold(email.as_deref().unwrap_or("an account"))
                    );
                    println!(
                        "  {}",
                        dim(
                            "Not logged in with `whk auth login`; `whk sandbox status` shows the connection."
                        )
                    );
                }
            }
            _ => {
                let hint = crate::api::ignored_key_hint();
                if json {
                    println!(
                        "{}",
                        serde_json::json!({ "logged_in": false, "hint": hint })
                    );
                } else {
                    println!("  {} Not logged in", red("●"));
                    match hint {
                        Some(hint) => println!("  {}", dim(hint)),
                        None => println!("  Run {} to authenticate.", bold("whk auth login")),
                    }
                }
            }
        },
    }
    Ok(())
}

pub async fn logout(client: &ApiClient, json: bool) -> Result<()> {
    auth::clear_token()?;
    if json {
        println!("{}", serde_json::json!({ "status": "logged_out" }));
    } else {
        println!("  Logged out.");
        // The commands would go on acting through a saved agent connection.
        if CredentialStore::locate(&client.base_url)
            .load()
            .claimed
            .is_some()
        {
            println!(
                "  {}",
                dim(
                    "An agent's account connection is still saved; `whk sandbox forget --claimed` removes it."
                )
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod remote_tests {
    use super::remote_session;

    fn env(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn ssh_is_remote() {
        assert!(remote_session(env(&[
            ("SSH_CONNECTION", "203.0.113.7 51000 10.0.0.2 22"),
            ("DISPLAY", ":0"),
        ])));
        assert!(remote_session(env(&[
            ("SSH_TTY", "/dev/pts/1"),
            ("DISPLAY", ":0")
        ])));
    }

    #[test]
    fn a_desktop_is_not_remote() {
        assert!(!remote_session(env(&[("DISPLAY", ":0")])));
        assert!(!remote_session(env(&[
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("SSH_CONNECTION", " "),
        ])));
    }

    #[test]
    fn wsl_without_a_display_is_local() {
        assert!(!remote_session(env(&[("WSL_DISTRO_NAME", "Ubuntu")])));
        assert!(remote_session(env(&[
            ("WSL_DISTRO_NAME", "Ubuntu"),
            ("SSH_CONNECTION", "203.0.113.7 51000 10.0.0.2 22"),
        ])));
    }

    #[test]
    fn linux_without_a_display_is_remote() {
        assert_eq!(remote_session(env(&[])), cfg!(target_os = "linux"));
    }
}
