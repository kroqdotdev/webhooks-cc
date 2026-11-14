use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::account::{ApprovalOptions, ask};
use crate::cli::confirm::confirm;
use crate::cli::output::{bold, dim, green, red, sanitize};
use crate::types::{Team, TeamInvite, TeamMember};
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
            many.iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

pub async fn find_team(client: &ApiClient, needle: &str) -> Result<Team> {
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
    // Pad before dimming: the escape codes would otherwise count toward the
    // column width and shift every header right of NAME.
    println!(
        "  {}",
        dim(&format!(
            "{:<24} {:<8} {:<6} {:<8} {:<22} {:<12} {}",
            "NAME", "ROLE", "SEATS", "MEMBERS", "REQUESTS", "STATUS", "ID"
        ))
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
            "  {}",
            dim(&format!(
                "{:<24} {:<28} {:<20} {}",
                "TEAM", "FROM", "SENT", "INVITE ID"
            ))
        );
    } else {
        println!(
            "  {}",
            dim(&format!(
                "{:<32} {:<28} {:<20} {}",
                "EMAIL", "FROM", "SENT", "INVITE ID"
            ))
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
        println!("{}", serde_json::to_string_pretty(&teams.json())?);
        return Ok(());
    }

    if teams.is_empty() {
        println!(
            "  No teams. Create one at {}",
            bold("https://webhooks.cc/teams")
        );
        return Ok(());
    }

    print_team_table(&teams);
    Ok(())
}

pub async fn members(client: &ApiClient, team: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let result = client.list_team_members(&team.id).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&result.json())?);
        return Ok(());
    }

    println!("{} ({})", bold(&sanitize(&team.name)), status_label(&team));
    println!(
        "  {}",
        dim(&format!(
            "{:<32} {:<24} {:<8} {}",
            "EMAIL", "NAME", "ROLE", "JOINED"
        ))
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
    let (team, endpoint) = tokio::try_join!(find_team(client, team), client.get_endpoint(slug))?;
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
    let (team, endpoint) = tokio::try_join!(find_team(client, team), client.get_endpoint(slug))?;
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
        println!("{}", serde_json::to_string_pretty(&invite.json())?);
    } else {
        println!(
            "{} Invited {} to {}",
            green("✓"),
            bold(&sanitize(&invite.invited_email)),
            bold(&sanitize(&team.name))
        );
        match &invite.warning {
            // The route answers 200 with a warning when the invite row exists
            // but the email did not go out; the invitee only finds it in-app.
            Some(warning) => println!(
                "{} {} Tell them to sign up with that address and accept from their Teams page.",
                red("!"),
                sanitize(warning)
            ),
            None => println!(
                "{}",
                dim("They get an email; accepting claims one of the team's seats.")
            ),
        }
    }
    Ok(())
}

pub async fn invites(client: &ApiClient, json: bool) -> Result<()> {
    let invites = client.list_invites().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&invites.json())?);
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
        println!(
            "{}",
            serde_json::json!({ "accepted": true, "inviteId": invite_id })
        );
    } else {
        println!(
            "{} Invite accepted. Run {} to see the team.",
            green("✓"),
            bold("whk teams list")
        );
    }
    Ok(())
}

pub async fn decline(client: &ApiClient, invite_id: &str, json: bool) -> Result<()> {
    client.decline_invite(invite_id).await?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "declined": true, "inviteId": invite_id })
        );
    } else {
        println!("{} Invite declined.", green("✓"));
    }
    Ok(())
}

/// Picks a member by user id (exact) or email (case-insensitive) out of a
/// team's member list.
pub fn resolve_member<'a>(members: &'a [TeamMember], needle: &str) -> Result<&'a TeamMember> {
    let needle = needle.trim();
    if needle.is_empty() {
        anyhow::bail!("member is required (a user id or email; see `whk teams members`)");
    }
    if let Some(member) = members.iter().find(|m| m.user_id == needle) {
        return Ok(member);
    }
    let lowered = needle.to_lowercase();
    members
        .iter()
        .find(|m| m.email.to_lowercase() == lowered)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no member with user id or email {needle:?}; run `whk teams members <team>` to see them"
            )
        })
}

/// Picks a pending invite by id (exact) or the invited email
/// (case-insensitive) out of a team's pending invites.
pub fn resolve_invite<'a>(invites: &'a [TeamInvite], needle: &str) -> Result<&'a TeamInvite> {
    let needle = needle.trim();
    if needle.is_empty() {
        anyhow::bail!("invite is required (an invite id or the invited email)");
    }
    if let Some(invite) = invites.iter().find(|i| i.id == needle) {
        return Ok(invite);
    }
    let lowered = needle.to_lowercase();
    invites
        .iter()
        .find(|i| i.invited_email.to_lowercase() == lowered)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no pending invite with id or email {needle:?}; run `whk teams members <team>` to see them"
            )
        })
}

pub async fn create(client: &ApiClient, name: &str, json: bool) -> Result<()> {
    let team = client.create_team(name.trim()).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&team.json())?);
        return Ok(());
    }
    println!(
        "{} Created team {} {}",
        green("✓"),
        bold(&sanitize(&team.name)),
        dim(&team.id)
    );
    println!(
        "{}",
        dim(
            "It needs a subscription (Account > Teams in the browser) before endpoints can be shared or members invited."
        )
    );
    Ok(())
}

pub async fn rename(client: &ApiClient, team: &str, name: &str, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let name = name.trim();
    client.rename_team(&team.id, name).await?;
    if json {
        println!(
            "{}",
            json!({ "renamed": true, "teamId": team.id, "name": name })
        );
    } else {
        println!(
            "{} Renamed {} to {}",
            green("✓"),
            bold(&sanitize(&team.name)),
            bold(&sanitize(name))
        );
    }
    Ok(())
}

pub async fn delete(
    client: &ApiClient,
    team: &str,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let team = find_team(client, team).await?;
    let answer = client.delete_team(&team.id).await?;
    // A browser session deletes at once and answers 204: say what went.
    let answer = if answer.is_null() {
        json!({ "deleted": team.name, "teamId": team.id })
    } else {
        answer
    };
    ask(client, answer, opts, json, |done| {
        let name = done
            .get("deleted")
            .and_then(Value::as_str)
            .unwrap_or_default();
        println!("  {} Deleted team {}", red("✓"), bold(&sanitize(name)));
    })
    .await
}

pub async fn remove(
    client: &ApiClient,
    team: &str,
    member: &str,
    yes: bool,
    json: bool,
) -> Result<()> {
    let team = find_team(client, team).await?;
    let members = client.list_team_members(&team.id).await?;
    let member = resolve_member(&members.members, member)?.clone();
    confirm(
        &format!(
            "Remove {} from {}? Endpoints they shared with the team stop being shared.",
            sanitize(&member.email),
            sanitize(&team.name)
        ),
        yes,
    )?;
    client.remove_team_member(&team.id, &member.user_id).await?;
    if json {
        println!(
            "{}",
            json!({ "removed": member.user_id, "email": member.email, "teamId": team.id })
        );
    } else {
        println!(
            "{} Removed {} from {}",
            red("✓"),
            bold(&sanitize(&member.email)),
            bold(&sanitize(&team.name))
        );
        println!("{}", dim("Their seat is free for someone else."));
    }
    Ok(())
}

pub async fn leave(client: &ApiClient, team: &str, yes: bool, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    confirm(
        &format!(
            "Leave {}? Endpoints you shared with it stop being shared.",
            sanitize(&team.name)
        ),
        yes,
    )?;
    client.leave_team(&team.id).await?;
    if json {
        println!("{}", json!({ "left": true, "teamId": team.id }));
    } else {
        println!("{} Left {}", red("✓"), bold(&sanitize(&team.name)));
    }
    Ok(())
}

pub async fn withdraw(
    client: &ApiClient,
    team: &str,
    invite: &str,
    yes: bool,
    json: bool,
) -> Result<()> {
    let team = find_team(client, team).await?;
    let members = client.list_team_members(&team.id).await?;
    let invite = resolve_invite(&members.pending_invites, invite)?.clone();
    confirm(
        &format!(
            "Withdraw the invite for {} to {}?",
            sanitize(&invite.invited_email),
            sanitize(&team.name)
        ),
        yes,
    )?;
    client.withdraw_invite(&team.id, &invite.id).await?;
    if json {
        println!(
            "{}",
            json!({ "withdrawn": invite.id, "email": invite.invited_email, "teamId": team.id })
        );
    } else {
        println!(
            "{} Withdrew the invite for {}",
            red("✓"),
            bold(&sanitize(&invite.invited_email))
        );
    }
    Ok(())
}

/// What `whk teams quote` prices: a seat count, or a plan and interval.
pub enum QuoteAsk {
    Seats(u32),
    Plan { plan: String, interval: String },
}

pub async fn quote(client: &ApiClient, team: &str, ask: QuoteAsk, json: bool) -> Result<()> {
    let team = find_team(client, team).await?;
    let quote = match &ask {
        QuoteAsk::Seats(seats) => client.quote_team_seats(&team.id, *seats).await?,
        QuoteAsk::Plan { plan, interval } => {
            client.quote_team_plan(&team.id, plan, interval).await?
        }
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&quote.json())?);
        return Ok(());
    }
    println!("{}", bold(&sanitize(&team.name)));
    let lines = match ask {
        QuoteAsk::Seats(_) => seat_quote_lines(&quote.value),
        QuoteAsk::Plan { .. } => plan_quote_lines(&quote.value),
    };
    for line in lines {
        println!("{line}");
    }
    println!(
        "\n  {}",
        dim("A quote only: seat and plan changes are made in the browser, under the team's Plan.")
    );
    Ok(())
}

fn money(v: &Value) -> String {
    let cents = v.as_i64().unwrap_or(0);
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.unsigned_abs();
    format!("{sign}${}.{:02}", cents / 100, cents % 100)
}

fn quote_date(v: &Value) -> String {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| format_timestamp(t.timestamp_millis()))
        .unwrap_or_else(|| "-".into())
}

fn seat_quote_lines(q: &Value) -> Vec<String> {
    let mut out = vec![format!(
        "  Seats: {} to {}",
        q["currentSeats"].as_u64().unwrap_or(0),
        q["newSeats"].as_u64().unwrap_or(0)
    )];
    if let Some(pending) = q["pendingSeats"].as_u64() {
        out.push(format!(
            "  Already scheduled: {pending} seats from the renewal"
        ));
    }
    out.push(format!(
        "  Price per seat: {}",
        money(&q["pricePerSeatCents"])
    ));
    if q["appliesAtRenewal"].as_bool() == Some(true) {
        out.push(format!(
            "  Applies at the renewal ({}); nothing is charged now",
            quote_date(&q["periodEnd"])
        ));
    } else {
        out.push(format!(
            "  For the rest of the period: {}",
            money(&q["prorationCents"])
        ));
        if q["creditAppliedCents"].as_i64().unwrap_or(0) > 0 {
            out.push(format!(
                "  Account credit used: {}",
                money(&q["creditAppliedCents"])
            ));
        }
        out.push(format!("  Due now: {}", bold(&money(&q["dueNowCents"]))));
    }
    out.push(format!(
        "  Then {} a month from the renewal",
        money(&q["renewalCents"])
    ));
    out
}

fn plan_quote_lines(q: &Value) -> Vec<String> {
    let plan = match q["plan"].as_str().unwrap_or("") {
        "team" => "Teams",
        "team_business" => "Team Business",
        other => other,
    };
    let interval = match q["interval"].as_str().unwrap_or("") {
        "year" => "annual",
        _ => "monthly",
    };
    let mut out = vec![format!(
        "  Plan: {} ({interval}), {} seats",
        sanitize(plan),
        q["seats"].as_u64().unwrap_or(0)
    )];
    if q["applies"].as_str() == Some("renewal") {
        out.push(format!(
            "  Applies at the renewal ({}); nothing is charged now",
            quote_date(&q["periodEnd"])
        ));
    } else {
        out.push(format!(
            "  New price for what it covers: {}",
            money(&q["chargeCents"])
        ));
        if q["creditCents"].as_i64().unwrap_or(0) > 0 {
            out.push(format!(
                "  Unused part of the current price: -{}",
                money(&q["creditCents"])
            ));
        }
        if q["creditAppliedCents"].as_i64().unwrap_or(0) > 0 {
            out.push(format!(
                "  Account credit used: {}",
                money(&q["creditAppliedCents"])
            ));
        }
        out.push(format!(
            "  Due now: about {}",
            bold(&money(&q["dueNowCents"]))
        ));
        out.push(format!("  First renewal: {}", quote_date(&q["periodEnd"])));
    }
    let per = if q["interval"].as_str() == Some("year") {
        "a year"
    } else {
        "a month"
    };
    out.push(format!("  Then {} {per}", money(&q["renewalCents"])));
    out
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
        assert!(
            resolve_team(&teams, "nope")
                .unwrap_err()
                .to_string()
                .contains("no team")
        );
        assert!(
            resolve_team(&teams, "   ")
                .unwrap_err()
                .to_string()
                .contains("required")
        );
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

    fn member(user_id: &str, email: &str) -> TeamMember {
        TeamMember {
            user_id: user_id.to_string(),
            email: email.to_string(),
            name: None,
            role: "member".to_string(),
            joined_at: None,
        }
    }

    fn pending(id: &str, email: &str) -> TeamInvite {
        TeamInvite {
            id: id.to_string(),
            team_id: "t1".to_string(),
            team_name: "Payments".to_string(),
            inviter_email: "owner@example.com".to_string(),
            invited_email: email.to_string(),
            status: "pending".to_string(),
            created_at: None,
            warning: None,
        }
    }

    #[test]
    fn resolves_a_member_by_user_id_or_email() {
        let members = vec![
            member("u1", "dev@example.com"),
            member("u2", "ops@example.com"),
        ];
        assert_eq!(
            resolve_member(&members, "u2").unwrap().email,
            "ops@example.com"
        );
        assert_eq!(
            resolve_member(&members, " Dev@Example.com ")
                .unwrap()
                .user_id,
            "u1"
        );
        let err = resolve_member(&members, "nobody@example.com")
            .unwrap_err()
            .to_string();
        assert!(err.contains("no member"), "{err}");
        assert!(
            resolve_member(&members, "  ")
                .unwrap_err()
                .to_string()
                .contains("required")
        );
    }

    #[test]
    fn resolves_an_invite_by_id_or_invited_email() {
        let invites = vec![
            pending("i1", "new@example.com"),
            pending("i2", "late@example.com"),
        ];
        assert_eq!(
            resolve_invite(&invites, "i2").unwrap().invited_email,
            "late@example.com"
        );
        assert_eq!(
            resolve_invite(&invites, "NEW@example.com").unwrap().id,
            "i1"
        );
        assert!(
            resolve_invite(&invites, "other@example.com")
                .unwrap_err()
                .to_string()
                .contains("no pending invite")
        );
    }

    #[test]
    fn prices_a_seat_increase_and_a_reduction() {
        let up = seat_quote_lines(&json!({
            "currentSeats": 2, "newSeats": 4, "pendingSeats": null, "appliesAtRenewal": false,
            "pricePerSeatCents": 1500, "prorationCents": 1499, "creditAppliedCents": 0,
            "dueNowCents": 1499, "renewalCents": 6000, "periodEnd": "2026-12-10T00:00:00.000Z"
        }))
        .join("\n");
        assert!(up.contains("Seats: 2 to 4"), "{up}");
        assert!(up.contains("$14.99"), "{up}");
        assert!(up.contains("Then $60.00 a month"), "{up}");
        let down = seat_quote_lines(&json!({
            "currentSeats": 4, "newSeats": 2, "pendingSeats": null, "appliesAtRenewal": true,
            "pricePerSeatCents": 1500, "prorationCents": 0, "creditAppliedCents": 0,
            "dueNowCents": 0, "renewalCents": 3000, "periodEnd": "2026-12-10T00:00:00.000Z"
        }))
        .join("\n");
        assert!(down.contains("nothing is charged now"), "{down}");
        assert!(!down.contains("Due now"), "{down}");
    }

    #[test]
    fn prices_a_plan_change() {
        let lines = plan_quote_lines(&json!({
            "plan": "team_business", "interval": "year", "seats": 3, "applies": "now",
            "creditCents": 2000, "chargeCents": 105000, "creditAppliedCents": 0,
            "dueNowCents": 103000, "renewalCents": 105000, "periodEnd": "2027-11-14T00:00:00.000Z"
        }))
        .join("\n");
        assert!(lines.contains("Team Business (annual), 3 seats"), "{lines}");
        assert!(lines.contains("$1030.00"), "{lines}");
        assert!(lines.contains("Then $1050.00 a year"), "{lines}");
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

    const TEAM: &str = "4f8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

    fn teams_route() -> axum::routing::MethodRouter {
        axum::routing::get(|| async {
            axum::Json(json!([{
                "id": TEAM, "name": "Payments", "role": "owner", "seats": 2,
                "requestsUsed": 0, "requestLimit": 200000, "periodEnd": null, "suspended": false
            }]))
        })
    }

    #[tokio::test]
    async fn deleting_a_team_asks_for_approval_then_collects_it() {
        let polls = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        let approval = |status: &str| {
            json!({
                "id": "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f", "status": status,
                "action": "teams.delete", "summary": "Delete the team \"Payments\".",
                "code": "ABCD-EFGH", "url": "https://webhooks.cc/approve?code=ABCD-EFGH",
                "expiresAt": "2026-11-14T12:15:00.000Z",
            })
        };
        let app = axum::Router::new()
            .route("/api/teams", teams_route())
            .route(
                "/api/teams/{id}",
                axum::routing::delete(
                    move |axum::extract::Path(id): axum::extract::Path<String>| async move {
                        assert_eq!(id, TEAM);
                        (
                            axum::http::StatusCode::ACCEPTED,
                            axum::Json(json!({ "approval": approval("pending") })),
                        )
                    },
                ),
            )
            .route(
                "/api/approvals/{id}",
                axum::routing::get(move || {
                    let polls = polls.clone();
                    async move {
                        let mut n = polls.lock().unwrap();
                        *n += 1;
                        if *n < 2 {
                            return axum::Json(json!({ "approval": approval("pending") }));
                        }
                        axum::Json(json!({
                            "approval": approval("completed"),
                            "result": { "deleted": "Payments", "teamId": TEAM },
                        }))
                    }
                }),
            );
        let base = serve(app).await;
        let opts = ApprovalOptions {
            remote: true,
            no_browser: true,
            no_wait: false,
            timeout: "1m".into(),
        };
        delete(&client(&base), "payments", opts, true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn removing_a_member_by_email_sends_their_user_id() {
        let removed: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
        let seen = removed.clone();
        let app = axum::Router::new()
            .route("/api/teams", teams_route())
            .route(
                "/api/teams/{id}/members",
                axum::routing::get(|| async {
                    axum::Json(json!({
                        "members": [
                            { "userId": "u-owner", "email": "owner@example.com", "role": "owner" },
                            { "userId": "u-dev", "email": "dev@example.com", "role": "member" }
                        ],
                        "pendingInvites": []
                    }))
                }),
            )
            .route(
                "/api/teams/{id}/members/{user}",
                axum::routing::delete(
                    move |axum::extract::Path((_, user)): axum::extract::Path<(String, String)>| async move {
                        *seen.lock().unwrap() = Some(user);
                        axum::Json(json!({ "success": true }))
                    },
                ),
            );
        let base = serve(app).await;
        remove(&client(&base), "Payments", "DEV@example.com", true, true)
            .await
            .unwrap();
        assert_eq!(removed.lock().unwrap().as_deref(), Some("u-dev"));
    }
}
