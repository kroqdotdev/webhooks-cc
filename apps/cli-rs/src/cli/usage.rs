use anyhow::Result;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, print_usage, sanitize};
use crate::types::Team;
use crate::util::format::format_timestamp;

pub async fn run(client: &ApiClient, json: bool) -> Result<()> {
    let usage = client.get_usage().await?;
    // Team pools are additive information; a failure there must not hide the
    // personal quota, so it degrades to an empty list with a note.
    let teams: Vec<Team> = match client.list_teams().await {
        Ok(teams) => teams.into_iter().filter(|t| !t.suspended).collect(),
        Err(e) => {
            if !json {
                eprintln!("  {} {}", dim("Could not load team pools:"), e);
            }
            Vec::new()
        }
    };

    if json {
        let mut value = serde_json::to_value(&usage)?;
        value["teams"] = serde_json::to_value(
            teams
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "name": t.name,
                        "role": t.role,
                        "seats": t.seats,
                        "used": t.requests_used,
                        "limit": t.request_limit,
                        "remaining": t.request_limit.saturating_sub(t.requests_used),
                        "periodEnd": t.period_end,
                    })
                })
                .collect::<Vec<_>>(),
        )?;
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }

    print_usage(&usage);

    if teams.is_empty() {
        return Ok(());
    }

    println!("\n{}", bold("Team pools"));
    for team in &teams {
        println!(
            "  {} {}/{} ({} remaining, {} seats)",
            bold(&sanitize(&team.name)),
            team.requests_used,
            team.request_limit,
            team.request_limit.saturating_sub(team.requests_used),
            team.seats
        );
        if let Some(pe) = team.period_end {
            println!("    {} {}", dim("Period ends:"), format_timestamp(pe));
        }
    }

    Ok(())
}
