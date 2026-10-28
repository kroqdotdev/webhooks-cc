use anyhow::Result;
use std::time::Duration;

use crate::agent::CredentialStore;
use crate::api::{ApiClient, AuthSource};
use crate::auth;
use crate::cli::output::{bold, dim, green, red};
use crate::types::Token;

pub async fn login(client: &mut ApiClient, json: bool) -> Result<()> {
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

    // Step 1: Create device code
    let device = client.create_device_code().await?;

    if !json {
        println!("\n  {} {}\n", bold("Your code:"), green(&device.user_code));
        println!(
            "  Open {} and enter the code above.",
            bold(&device.verification_url)
        );
    }

    // Try to open browser (only if URL looks safe and not in JSON mode)
    if !json && device.verification_url.starts_with("https://") {
        let _ = open::that(&device.verification_url);
    }

    if !json {
        println!("\n  Waiting for authorization...");
    }

    // Step 2: Poll until authorized or expired
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;

        let poll = client.poll_device_code(&device.device_code).await?;
        match poll.status.as_str() {
            "authorized" => break,
            "expired" => {
                if json {
                    println!("{}", serde_json::json!({ "status": "expired" }));
                } else {
                    println!("\n  {} Code expired. Please try again.", red("Error:"));
                }
                return Ok(());
            }
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
                if json {
                    println!("{}", serde_json::json!({ "logged_in": false }));
                } else {
                    println!("  {} Not logged in", red("●"));
                    println!("  Run {} to authenticate.", bold("whk auth login"));
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
