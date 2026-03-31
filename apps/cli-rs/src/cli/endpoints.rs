use anyhow::Result;
use std::collections::HashMap;
use std::io::{self, Write};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, print_endpoint_table, red};
use crate::types::{CreateEndpointRequest, MockResponse, UpdateEndpointRequest};
use crate::util::format::parse_duration;

pub async fn create(
    client: &ApiClient,
    name: Option<String>,
    ephemeral: bool,
    expires_in: Option<String>,
    mock_status: Option<u16>,
    mock_body: Option<String>,
    mock_headers: Vec<String>,
    json: bool,
) -> Result<()> {
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

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint)?);
    } else {
        let url = client.webhook_url_for(&endpoint.slug);
        println!("\n  {} Created endpoint {}", green("✓"), bold(&endpoint.slug));
        println!("  {} {}\n", dim("URL:"), url);
    }

    Ok(())
}

pub async fn list(client: &ApiClient, json: bool) -> Result<()> {
    let list = client.list_endpoints().await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&list)?);
        return Ok(());
    }

    let mut all: Vec<_> = list.owned.iter().chain(list.shared.iter()).collect();
    if all.is_empty() {
        println!("  No endpoints found. Create one with {}", bold("whk create"));
        return Ok(());
    }

    // Sort owned first
    all.sort_by(|a, b| a.slug.cmp(&b.slug));
    let endpoints: Vec<_> = all.into_iter().cloned().collect();
    print_endpoint_table(&endpoints, &client.webhook_url);

    Ok(())
}

pub async fn get(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let endpoint = client.get_endpoint(slug).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint)?);
        return Ok(());
    }

    let url = client.webhook_url_for(&endpoint.slug);
    println!("{}", bold(&endpoint.slug));
    println!("  {} {}", dim("URL:"), url);
    if let Some(ref name) = endpoint.name {
        println!("  {} {}", dim("Name:"), name);
    }
    println!("  {} {}", dim("Requests:"), endpoint.request_count.unwrap_or(0));
    if endpoint.is_ephemeral {
        println!("  {} true", dim("Ephemeral:"));
    }
    if let Some(ref mock) = endpoint.mock_response {
        println!("  {} {} ({})", dim("Mock:"), mock.status, mock.body.chars().take(50).collect::<String>());
    }
    if !endpoint.shared_with.is_empty() {
        let teams: Vec<_> = endpoint.shared_with.iter().map(|t| t.team_name.as_str()).collect();
        println!("  {} {}", dim("Shared with:"), teams.join(", "));
    }

    Ok(())
}

pub async fn update_endpoint(
    client: &ApiClient,
    slug: &str,
    name: Option<String>,
    mock_status: Option<u16>,
    mock_body: Option<String>,
    mock_headers: Vec<String>,
    clear_mock: bool,
    json: bool,
) -> Result<()> {
    let mock_response = if clear_mock {
        Some(serde_json::Value::Null)
    } else {
        build_mock_response(mock_status, mock_body, mock_headers)?
            .map(|m| serde_json::to_value(m).unwrap())
    };

    let req = UpdateEndpointRequest {
        name,
        mock_response,
    };

    let endpoint = client.update_endpoint(slug, &req).await?;

    if json {
        println!("{}", serde_json::to_string_pretty(&endpoint)?);
    } else {
        println!("  {} Updated endpoint {}", green("✓"), bold(&endpoint.slug));
    }

    Ok(())
}

pub async fn delete(client: &ApiClient, slug: &str, force: bool, json: bool) -> Result<()> {
    if !force {
        print!(
            "  Delete endpoint {}? This cannot be undone. [y/N] ",
            bold(slug)
        );
        io::stdout().flush()?;

        let mut input = String::new();
        io::stdin().read_line(&mut input)?;
        if !input.trim().eq_ignore_ascii_case("y") {
            println!("  Cancelled.");
            return Ok(());
        }
    }

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
