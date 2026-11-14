use anyhow::Result;
use std::collections::HashMap;

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, print_endpoint_table, red, sanitize};
use crate::types::{CreateEndpointRequest, MockResponse, UpdateEndpointRequest, favorites_first};
use crate::util::format::parse_duration;

#[allow(clippy::too_many_arguments)]
pub async fn create(
    client: &ApiClient,
    name: Option<String>,
    ephemeral: bool,
    expires_in: Option<String>,
    mock_status: Option<u16>,
    mock_body: Option<String>,
    mock_headers: Vec<String>,
    signing_provider: Option<String>,
    signing_secret: Option<String>,
    json: bool,
) -> Result<()> {
    if signing_secret.is_some() && signing_provider.is_none() {
        anyhow::bail!("--signing-secret requires --signing-provider");
    }

    let mock_response = build_mock_response(mock_status, mock_body, mock_headers)?;

    let expires_at = match expires_in {
        Some(dur) => {
            let ms = parse_duration(&dur)?;
            Some(chrono::Utc::now().timestamp_millis() + ms)
        }
        None => None,
    };

    let req = CreateEndpointRequest {
        name: name.clone(),
        is_ephemeral: if ephemeral { Some(true) } else { None },
        expires_at,
        mock_response,
    };

    let endpoint = client.create_endpoint(&req).await?;

    // Configure signing if provided (update after create)
    let mut signing_configured = false;
    if let Some(ref provider) = signing_provider {
        use crate::types::UpdateEndpointRequest;
        let update = UpdateEndpointRequest {
            name: None,
            mock_response: None,
            signing_provider: Some(provider.clone()),
            signing_secret: signing_secret.clone(),
            signing_header: None,
            agent_repo: None,
        };
        match client.update_endpoint(&endpoint.slug, &update).await {
            Ok(_) => signing_configured = true,
            Err(e) => {
                eprintln!(
                    "  {} Endpoint {} was created but signing setup failed: {}",
                    red("⚠"),
                    bold(&endpoint.slug),
                    e
                );
                eprintln!("  Update the endpoint manually to configure signing.");
            }
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint.json())?);
    } else {
        let url = client.webhook_url_for(&endpoint.slug);
        println!(
            "\n  {} Created endpoint {}",
            green("✓"),
            bold(&endpoint.slug)
        );
        println!("  {} {}", dim("URL:"), url);
        if let Some(ref address) = endpoint.email_address {
            println!("  {} {}", dim("Email:"), address);
        }
        println!();
        if signing_configured {
            println!("  {} Signature verification configured\n", green("✓"));
        }
    }

    Ok(())
}

pub async fn list(client: &ApiClient, team: Option<&str>, json: bool) -> Result<()> {
    // Resolve `--team` the same way `whk teams` does (id, or unique name),
    // so an unknown or ambiguous name is an error rather than an empty list.
    let team = match team {
        Some(needle) => Some(crate::cli::teams::find_team(client, needle).await?),
        None => None,
    };
    let mut list = client.list_endpoints().await?;

    if let Some(team) = &team {
        let tied = |ep: &crate::types::Endpoint| {
            ep.from_teams
                .iter()
                .chain(ep.from_team.iter())
                .chain(ep.shared_with.iter())
                .any(|share| share.team_id == team.id)
        };
        list.owned.retain(tied);
        list.shared.retain(tied);
        // The printed JSON keeps the same endpoints.
        let kept: std::collections::HashSet<String> = list
            .owned
            .iter()
            .chain(list.shared.iter())
            .map(|ep| ep.slug.clone())
            .collect();
        for key in ["owned", "shared"] {
            if let Some(items) = list.raw.get_mut(key).and_then(|v| v.as_array_mut()) {
                items.retain(|ep| {
                    ep.get("slug")
                        .and_then(|s| s.as_str())
                        .is_some_and(|slug| kept.contains(slug))
                });
            }
        }
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&list.json())?);
        return Ok(());
    }

    let mut all: Vec<_> = list.owned.iter().chain(list.shared.iter()).collect();
    if all.is_empty() {
        match &team {
            Some(team) => println!(
                "  No endpoints tied to team {}. Share one with {}",
                bold(&team.name),
                bold("whk teams share <slug> --team <team>")
            ),
            None => println!(
                "  No endpoints found. Create one with {}",
                bold("whk create")
            ),
        }
        return Ok(());
    }

    all.sort_by(|a, b| a.slug.cmp(&b.slug));
    let mut endpoints: Vec<_> = all.into_iter().cloned().collect();
    favorites_first(&mut endpoints);
    print_endpoint_table(&endpoints, &client.webhook_url);

    Ok(())
}

pub async fn get(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let endpoint = client.get_endpoint(slug).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint.json())?);
        return Ok(());
    }

    let url = client.webhook_url_for(&endpoint.slug);
    println!("{}", bold(&endpoint.slug));
    println!("  {} {}", dim("URL:"), url);
    if let Some(ref address) = endpoint.email_address {
        println!("  {} {}", dim("Email:"), address);
    }
    if let Some(ref name) = endpoint.name {
        println!("  {} {}", dim("Name:"), name);
    }
    if let Some(count) = endpoint.request_count {
        println!("  {} {}", dim("Requests:"), count);
    }
    if endpoint.is_ephemeral {
        println!("  {} true", dim("Ephemeral:"));
    }
    if endpoint.is_favorite() {
        println!("  {} yes", dim("Favourite:"));
    }
    if let Some(ref mock) = endpoint.mock_response {
        println!(
            "  {} {} ({})",
            dim("Mock:"),
            mock.status,
            mock.body.chars().take(50).collect::<String>()
        );
    }
    if !endpoint.shared_with.is_empty() {
        let teams: Vec<_> = endpoint
            .shared_with
            .iter()
            .map(|t| t.team_name.as_str())
            .collect();
        println!("  {} {}", dim("Shared with:"), teams.join(", "));
    }

    Ok(())
}

/// What `whk update-endpoint` was asked to change.
pub struct EndpointUpdate {
    pub name: Option<String>,
    pub mock_status: Option<u16>,
    pub mock_body: Option<String>,
    pub mock_headers: Vec<String>,
    pub clear_mock: bool,
    pub agent_repo: Option<String>,
    pub clear_agent_repo: bool,
}

/// GitHub's rules, as the API checks them: an owner of letters, digits and
/// dashes (not starting with a dash, at most 39), then a repository name of
/// letters, digits, dots, dashes and underscores (at most 100, not only dots).
/// Spaces around it and a trailing `.git` are dropped, and what is then empty
/// (`--agent-repo ""`) clears it, as the API reads it: `Ok(None)`.
pub fn parse_agent_repo(value: &str) -> Result<Option<String>> {
    let trimmed = value.trim();
    let repo = trimmed
        .len()
        .checked_sub(4)
        .and_then(|cut| Some((trimmed.get(..cut)?, trimmed.get(cut..)?)))
        .filter(|(_, suffix)| suffix.eq_ignore_ascii_case(".git"))
        .map_or(trimmed, |(head, _)| head);
    if repo.is_empty() {
        return Ok(None);
    }
    let valid = repo.split_once('/').is_some_and(|(owner, name)| {
        let owner_ok = !owner.is_empty()
            && owner.len() <= 39
            && !owner.starts_with('-')
            && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        let name_ok = !name.is_empty()
            && name.len() <= 100
            && !name.chars().all(|c| c == '.')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        owner_ok && name_ok
    });
    if !valid {
        return Err(crate::error::CliError::Usage(format!(
            "--agent-repo must be a GitHub repository as owner/name, not {}",
            sanitize(value)
        ))
        .into());
    }
    Ok(Some(repo.to_string()))
}

pub async fn update_endpoint(
    client: &ApiClient,
    slug: &str,
    update: EndpointUpdate,
    json: bool,
) -> Result<()> {
    let mock_response = if update.clear_mock {
        Some(serde_json::Value::Null)
    } else {
        build_mock_response(update.mock_status, update.mock_body, update.mock_headers)?
            .map(|m| serde_json::to_value(m).expect("MockResponse is always serializable"))
    };
    let agent_repo = if update.clear_agent_repo {
        Some(serde_json::Value::Null)
    } else {
        update
            .agent_repo
            .as_deref()
            .map(parse_agent_repo)
            .transpose()?
            .map(|repo| repo.map_or(serde_json::Value::Null, serde_json::Value::String))
    };

    let req = UpdateEndpointRequest {
        name: update.name,
        mock_response,
        signing_provider: None,
        signing_secret: None,
        signing_header: None,
        agent_repo,
    };

    let endpoint = client.update_endpoint(slug, &req).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint.json())?);
    } else {
        println!("  {} Updated endpoint {}", green("✓"), bold(&endpoint.slug));
    }

    Ok(())
}

/// `whk favorite` and `whk unfavorite`: idempotent, so marking a favourite
/// twice is not an error.
pub async fn set_favorite(
    client: &ApiClient,
    slug: &str,
    favorite: bool,
    json: bool,
) -> Result<()> {
    let state = client.set_endpoint_favorite(slug, favorite).await?;

    if json {
        println!(
            "{}",
            serde_json::json!({ "slug": slug, "favorite": state.favorite })
        );
    } else if state.favorite {
        println!(
            "  {} Marked {} as a favourite",
            green("★"),
            bold(&sanitize(slug))
        );
    } else {
        println!(
            "  {} Removed {} from your favourites",
            green("✓"),
            bold(&sanitize(slug))
        );
    }

    Ok(())
}

pub async fn delete(client: &ApiClient, slug: &str, force: bool, json: bool) -> Result<()> {
    crate::cli::confirm::confirm(
        &format!("Delete endpoint {slug}? This cannot be undone."),
        force,
    )?;

    client.delete_endpoint(slug).await?;

    if json {
        println!("{}", serde_json::json!({ "deleted": slug }));
    } else {
        println!("  {} Deleted endpoint {}", red("✓"), bold(slug));
    }

    Ok(())
}

fn build_mock_response(
    status: Option<u16>,
    body: Option<String>,
    headers: Vec<String>,
) -> Result<Option<MockResponse>> {
    if status.is_none() && body.is_none() && headers.is_empty() {
        return Ok(None);
    }

    let status = status.unwrap_or(200);
    if !(100..=599).contains(&status) {
        anyhow::bail!("mock status must be between 100 and 599");
    }

    let mut header_map = HashMap::new();
    for h in headers {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("invalid header format: {h} (expected Key:Value)"))?;
        header_map.insert(k.trim().to_string(), v.trim().to_string());
    }

    Ok(Some(MockResponse {
        status,
        body: body.unwrap_or_default(),
        headers: header_map,
        delay: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_repo_takes_owner_and_name() {
        assert_eq!(parse_agent_repo("acme/api").unwrap().unwrap(), "acme/api");
        assert_eq!(
            parse_agent_repo(" acme/api.git ").unwrap().unwrap(),
            "acme/api"
        );
        assert_eq!(
            parse_agent_repo("Acme-Inc/web.app_2").unwrap().unwrap(),
            "Acme-Inc/web.app_2"
        );
        let longest = format!("{}/{}", "a".repeat(39), "b".repeat(100));
        assert_eq!(parse_agent_repo(&longest).unwrap().unwrap(), longest);
    }

    #[test]
    fn agent_repo_empty_clears_it_as_the_api_does() {
        for empty in ["", "  ", ".git", " .GIT "] {
            assert_eq!(parse_agent_repo(empty).unwrap(), None, "{empty:?}");
        }
    }

    #[test]
    fn agent_repo_refuses_anything_else() {
        for bad in [
            "acme",
            "acme/",
            "/api",
            "-acme/api",
            "acme/api/extra",
            "acme/..",
            "acme/.git",
            "acme_inc/api",
            "ac me/api",
            "https://github.com/acme/api",
            "acme/api?x=1",
            "acme/ap\u{e9}",
        ] {
            let err = parse_agent_repo(bad).unwrap_err();
            assert!(
                matches!(
                    err.downcast_ref::<crate::error::CliError>(),
                    Some(crate::error::CliError::Usage(_))
                ),
                "{bad} should be a usage error"
            );
        }
        assert!(parse_agent_repo(&format!("{}/api", "a".repeat(40))).is_err());
        assert!(parse_agent_repo(&format!("acme/{}", "a".repeat(101))).is_err());
    }

    #[test]
    fn update_request_sends_agent_repo_only_when_asked() {
        let base = UpdateEndpointRequest {
            name: None,
            mock_response: None,
            signing_provider: None,
            signing_secret: None,
            signing_header: None,
            agent_repo: None,
        };
        assert_eq!(serde_json::to_value(&base).unwrap(), serde_json::json!({}));
        let set = UpdateEndpointRequest {
            agent_repo: Some(serde_json::Value::String("acme/api".into())),
            ..base.clone()
        };
        assert_eq!(
            serde_json::to_value(&set).unwrap(),
            serde_json::json!({ "agentRepo": "acme/api" })
        );
        let clear = UpdateEndpointRequest {
            agent_repo: Some(serde_json::Value::Null),
            ..base
        };
        assert_eq!(
            serde_json::to_value(&clear).unwrap(),
            serde_json::json!({ "agentRepo": null })
        );
    }
}
