use anyhow::Result;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize};
use crate::types::{Team, TeamInvite};
use crate::util::format::format_timestamp;

/// Picks one team out of the caller's teams by id (exact) or by name
/// (case-insensitive). A name shared by several teams is an error rather than
/// a guess, because sharing an endpoint with the wrong team moves its billing.
pub fn resolve_team<'a>(teams: &'a [Team], needle: &str) -> Result<&'a Team> {
    let needle = needle.trim();
    if needle.is_empty() {
        anyhow::bail!("team is required (a team id or name; see `whk teams list`)");
    }

    if let Some(team) = teams.iter().find(|t| t.id == needle) {
        return Ok(team);
    }

    let lowered = needle.to_lowercase();
    let by_name: Vec<&Team> = teams
        .iter()
        .filter(|t| t.name.to_lowercase() == lowered)
        .collect();

    match by_name.as_slice() {
        [team] => Ok(team),
        [] => anyhow::bail!(
            "no team named or with id {needle:?}; run `whk teams list` to see your teams"
        ),
        many => anyhow::bail!(
            "{} teams are named {needle:?}; pass the id instead ({})",
            many.len(),
            many.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", ")
        ),
    }
}

async fn find_team(client: &ApiClient, needle: &str) -> Result<Team> {
    let teams = client.list_teams().await?;
    resolve_team(&teams, needle).cloned()
}

fn status_label(team: &Team) -> String {
    if team.suspended {
        return "suspended".to_string();
    }
    let status = team.subscription_status.as_deref().unwrap_or("active");
    if team.cancel_at_period_end {
        format!("{status} (ends at period end)")
    } else {
        status.to_string()
    }
}

pub fn print_team_table(teams: &[Team]) {
    println!(
        "  {:<24} {:<8} {:<6} {:<8} {:<22} {:<12} {}",
        dim("NAME"),
        dim("ROLE"),
        dim("SEATS"),
        dim("MEMBERS"),
        dim("REQUESTS"),
        dim("STATUS"),
        dim("ID"),
    );
    for team in teams {
        let requests = if team.suspended {
            "-".to_string()
        } else {
            format!("{}/{}", team.requests_used, team.request_limit)
        };
        println!(
            "  {:<24} {:<8} {:<6} {:<8} {:<22} {:<12} {}",
            bold(&sanitize(&team.name)),
            sanitize(&team.role),
            team.seats,
            team.member_count,
            requests,
            status_label(team),
            dim(&team.id),
        );
    }
}

fn print_invite_table(invites: &[TeamInvite], show_team: bool) {
    if show_team {
        println!(
            "  {:<24} {:<28} {:<20} {}",
            dim("TEAM"),
            dim("FROM"),
            dim("SENT"),
            dim("INVITE ID"),
        );
    } else {
        println!(
            "  {:<32} {:<28} {:<20} {}",
            dim("EMAIL"),
            dim("FROM"),
            dim("SENT"),
            dim("INVITE ID"),
        );
    }
    for invite in invites {
        let sent = invite
            .created_at
            .map(format_timestamp)
            .unwrap_or_else(|| "-".to_string());
        if show_team {
            println!(
                "  {:<24} {:<28} {:<20} {}",
                bold(&sanitize(&invite.team_name)),
                sanitize(&invite.inviter_email),
                sent,
                dim(&invite.id),
            );
        } else {
            println!(
                "  {:<32} {:<28} {:<20} {}",
                sanitize(&invite.invited_email),
                sanitize(&invite.inviter_email),
                sent,
                dim(&invite.id),
            );
        }
    }
}

pub async fn list(client: &ApiClient, json: bool) -> Result<()> {
    let teams = client.list_teams().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&teams)?);
        return Ok(());
    }

    if teams.is_empty() {
        println!("  No teams. Create one at {}", bold("https://webhooks.cc/teams"));
        return Ok(());
    }

    print_team_table(&teams);
    Ok(())
}

pub async fn members(client: &ApiClient, team: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let result = client.list_team_members(&team.id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

    println!("{} ({})", bold(&sanitize(&team.name)), status_label(&team));
    println!(
        "  {:<32} {:<24} {:<8} {}",
        dim("EMAIL"),
        dim("NAME"),
        dim("ROLE"),
        dim("JOINED"),
    );
    for member in &result.members {
        let joined = member
            .joined_at
            .map(format_timestamp)
            .unwrap_or_else(|| "-".to_string());
        println!(
            "  {:<32} {:<24} {:<8} {}",
            sanitize(&member.email),
            sanitize(member.name.as_deref().unwrap_or("-")),
            sanitize(&member.role),
            dim(&joined),
        );
    }

    if !result.pending_invites.is_empty() {
        println!("\n{}", bold("Pending invites"));
        print_invite_table(&result.pending_invites, false);
    }

    Ok(())
}

pub async fn share(client: &ApiClient, slug: &str, team: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let endpoint = client.get_endpoint(slug).await?;
    client.share_endpoint(&team.id, &endpoint.id).await?;

    if json {
        println!(
            "{}",
            serde_json::json!({ "shared": true, "slug": endpoint.slug, "teamId": team.id, "teamName": team.name })
        );
    } else {
        println!(
            "{} Shared {} with {}",
            green("✓"),
            bold(&sanitize(&endpoint.slug)),
            bold(&sanitize(&team.name))
        );
        println!(
            "{}",
            dim("Requests on this endpoint now count against the team's pooled quota.")
        );
    }
    Ok(())
}

pub async fn unshare(client: &ApiClient, slug: &str, team: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let endpoint = client.get_endpoint(slug).await?;
    client.unshare_endpoint(&team.id, &endpoint.id).await?;

    if json {
        println!(
            "{}",
            serde_json::json!({ "shared": false, "slug": endpoint.slug, "teamId": team.id, "teamName": team.name })
        );
    } else {
        println!(
            "{} Stopped sharing {} with {}",
            green("✓"),
            bold(&sanitize(&endpoint.slug)),
            bold(&sanitize(&team.name))
        );
    }
    Ok(())
}

pub async fn invite(client: &ApiClient, team: &str, email: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let invite = client.invite_team_member(&team.id, email).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&invite)?);
    } else {
        println!(
            "{} Invited {} to {}",
            green("✓"),
            bold(&sanitize(&invite.invited_email)),
            bold(&sanitize(&team.name))
        );
        println!(
            "{}",
            dim("They get an email; accepting claims one of the team's seats.")
        );
    }
    Ok(())
}

pub async fn invites(client: &ApiClient, json: bool) -> Result<()> {
    let invites = client.list_invites().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&invites)?);
        return Ok(());
    }

    if invites.is_empty() {
        println!("  No pending invites.");
        return Ok(());
    }

    print_invite_table(&invites, true);
    println!(
        "\n  {} whk teams accept <invite-id>   {} whk teams decline <invite-id>",
        dim("Accept:"),
        dim("Decline:")
    );
    Ok(())
}

pub async fn accept(client: &ApiClient, invite_id: &str, json: bool) -> Result<()> {
    client.accept_invite(invite_id).await?;
    if json {
        println!("{}", serde_json::json!({ "accepted": true, "inviteId": invite_id }));
    } else {
        println!("{} Invite accepted. Run {} to see the team.", green("✓"), bold("whk teams list"));
    }
    Ok(())
}

pub async fn decline(client: &ApiClient, invite_id: &str, json: bool) -> Result<()> {
    client.decline_invite(invite_id).await?;
    if json {
        println!("{}", serde_json::json!({ "declined": true, "inviteId": invite_id }));
    } else {
        println!("{} Invite declined.", green("✓"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team(id: &str, name: &str) -> Team {
        Team {
            id: id.to_string(),
            name: name.to_string(),
            role: "member".to_string(),
            member_count: 1,
            suspended: false,
            subscription_status: Some("active".to_string()),
            seats: 1,
            requests_used: 0,
            request_limit: 100_000,
            period_end: None,
            cancel_at_period_end: false,
        }
    }

    #[test]
    fn resolves_by_exact_id_before_name() {
        let teams = vec![team("abc", "Payments"), team("def", "abc")];
        assert_eq!(resolve_team(&teams, "abc").unwrap().name, "Payments");
    }

    #[test]
    fn resolves_by_name_case_insensitively() {
        let teams = vec![team("abc", "Payments"), team("def", "Platform")];
        assert_eq!(resolve_team(&teams, "  payments ").unwrap().id, "abc");
    }

    #[test]
    fn rejects_ambiguous_names_and_lists_ids() {
        let teams = vec![team("abc", "Payments"), team("def", "payments")];
        let err = resolve_team(&teams, "PAYMENTS").unwrap_err().to_string();
        assert!(err.contains("2 teams"), "{err}");
        assert!(err.contains("abc") && err.contains("def"), "{err}");
    }

    #[test]
    fn reports_unknown_and_empty_needles() {
        let teams = vec![team("abc", "Payments")];
        assert!(resolve_team(&teams, "nope").unwrap_err().to_string().contains("no team"));
        assert!(resolve_team(&teams, "   ").unwrap_err().to_string().contains("required"));
    }

    #[test]
    fn parses_team_json_with_missing_optional_fields() {
        let json = r#"[{"id":"t1","name":"A","role":"owner","seats":2,"requestsUsed":5,"requestLimit":200000,"periodEnd":null,"suspended":false}]"#;
        let teams: Vec<Team> = serde_json::from_str(json).unwrap();
        assert_eq!(teams[0].seats, 2);
        assert_eq!(teams[0].member_count, 0);
        assert!(teams[0].subscription_status.is_none());
        assert_eq!(status_label(&teams[0]), "active");
    }

    #[test]
    fn labels_suspended_and_canceling_teams() {
        let mut t = team("a", "A");
        t.cancel_at_period_end = true;
        assert_eq!(status_label(&t), "active (ends at period end)");
        t.suspended = true;
        assert_eq!(status_label(&t), "suspended");
    }
}
