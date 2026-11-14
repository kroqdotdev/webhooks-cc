//! `whk account`, `whk agents`, `whk share-links` and `whk domains`: the
//! account's display name, connected agents, public links to requests and
//! custom inbound domains. Reads, revokes, adding and checking domains act at
//! once; a new share link, removing a domain and a rename need the account's
//! owner to approve them on a web page, the way a new API key does
//! (`whk keys create`).

use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::keys::{collect, deadline, show_approval};
use crate::cli::output::{bold, dim, green, red, sanitize};
use crate::error::CliError;
use crate::types::Approval;
use crate::util::format::format_timestamp;

/// How whk shows and follows an approval.
pub struct ApprovalOptions {
    pub remote: bool,
    pub no_browser: bool,
    pub no_wait: bool,
    pub timeout: String,
}

impl From<crate::cli::ApprovalArgs> for ApprovalOptions {
    fn from(args: crate::cli::ApprovalArgs) -> Self {
        Self {
            remote: args.remote,
            no_browser: args.no_browser,
            no_wait: args.no_wait,
            timeout: args.timeout,
        }
    }
}

/// Follows the answer of a route that asks for approval with an API key:
/// shows the link and waits for the result, or prints what a browser
/// session got at once.
pub(crate) async fn ask(
    client: &ApiClient,
    answer: Value,
    opts: ApprovalOptions,
    json: bool,
    done: impl FnOnce(&Value),
) -> Result<()> {
    let deadline = deadline(&opts.timeout)?;
    let Some(raw) = answer.get("approval").cloned() else {
        if json {
            println!("{}", json!({ "status": "completed", "result": answer }));
        } else {
            done(&answer);
        }
        return Ok(());
    };
    let approval: Approval = serde_json::from_value(raw.clone())?;
    show_approval(&approval, &raw, opts.remote, opts.no_browser, json);
    if opts.no_wait {
        if !json {
            println!(
                "\n  When it is approved, run {} to see the result.",
                bold(&format!("whk approvals wait {}", approval.id))
            );
        }
        return Ok(());
    }
    if !json {
        println!("\n  Waiting for approval...");
    }
    collect(client, &approval.id, deadline, json).await
}

pub(crate) fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn when(value: &Value, field: &str) -> String {
    match value.get(field) {
        Some(Value::Number(n)) => n.as_i64().map(format_timestamp).unwrap_or_default(),
        Some(Value::String(iso)) => chrono::DateTime::parse_from_rfc3339(iso)
            .map(|t| format_timestamp(t.timestamp_millis()))
            .unwrap_or_else(|_| iso.clone()),
        _ => "never".into(),
    }
}

pub(crate) fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

// ─── Account ──────────────────────────────────────────────────────────────

pub async fn rename(
    client: &ApiClient,
    name: Option<&str>,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let answer = client.rename_account(name).await?;
    ask(client, answer, opts, json, |done| match done.get("name") {
        Some(Value::String(name)) => {
            println!(
                "  {} The display name is now {}",
                green("✓"),
                bold(&sanitize(name))
            )
        }
        _ => println!("  {} The display name was cleared", green("✓")),
    })
    .await
}

// ─── Connected agents ─────────────────────────────────────────────────────

pub async fn agents_list(client: &ApiClient, json: bool) -> Result<()> {
    let agents = client.list_agents().await?;
    if json {
        return print_json(&agents);
    }
    let list = agents.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("  No connected agents.");
        return Ok(());
    }
    for agent in &list {
        let name = agent
            .get("clientName")
            .and_then(Value::as_str)
            .unwrap_or("Unnamed agent");
        println!("  {}  {}", bold(&sanitize(name)), dim(text(agent, "kind")));
        println!(
            "    {}",
            dim(&format!(
                "id {}  connected {}  last used {}",
                text(agent, "id"),
                when(agent, "connectedAt"),
                when(agent, "lastUsedAt")
            ))
        );
    }
    Ok(())
}

pub async fn agents_disconnect(client: &ApiClient, id: &str, yes: bool, json: bool) -> Result<()> {
    crate::cli::confirm::confirm(
        &format!("Disconnect agent {id}? Its tokens stop working at once."),
        yes,
    )?;
    client.disconnect_agent(id).await?;
    if json {
        println!("{}", json!({ "disconnected": id }));
    } else {
        println!("  {} Disconnected agent {}", red("✓"), bold(id));
    }
    Ok(())
}

// ─── Share links ──────────────────────────────────────────────────────────

pub async fn share_links_list(
    client: &ApiClient,
    request_id: Option<&str>,
    json: bool,
) -> Result<()> {
    let links = client.list_share_links(request_id).await?;
    if json {
        return print_json(&links);
    }
    let list = links.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        println!("  No live share links.");
        return Ok(());
    }
    for link in &list {
        let url = format!("{}/s/{}", client.base_url, text(link, "token"));
        if link.get("method").is_some() {
            let slug = text(link, "endpointSlug");
            println!(
                "  {} {}  {}",
                bold(text(link, "method")),
                sanitize(text(link, "path")),
                dim(if slug.is_empty() {
                    "(request deleted)"
                } else {
                    slug
                })
            );
        }
        println!("    {}", url);
        println!(
            "    {}",
            dim(&format!(
                "id {}  expires {}",
                text(link, "id"),
                when(link, "expiresAt")
            ))
        );
    }
    Ok(())
}

pub async fn share_links_create(
    client: &ApiClient,
    request_id: &str,
    expires_in_days: u32,
    show_signatures: bool,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let answer = client
        .create_share_link(request_id, expires_in_days, !show_signatures)
        .await?;
    let base = client.base_url.clone();
    ask(client, answer, opts, json, move |done| {
        println!("  {} Share link:", green("✓"));
        println!("    {}/s/{}", base, text(done, "token"));
    })
    .await
}

pub async fn share_links_revoke(client: &ApiClient, id: &str, yes: bool, json: bool) -> Result<()> {
    crate::cli::confirm::confirm(
        &format!("Revoke share link {id}? Its page stops working at once."),
        yes,
    )?;
    client.revoke_share_link(id).await?;
    if json {
        println!("{}", json!({ "revoked": id }));
    } else {
        println!("  {} Revoked share link {}", red("✓"), bold(id));
    }
    Ok(())
}

// ─── Domains ──────────────────────────────────────────────────────────────

fn print_domain(domain: &Value) {
    let status = text(domain, "status");
    let active = domain
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!(
        "  {}  {}{}",
        bold(&sanitize(text(domain, "domain"))),
        status,
        if active { "" } else { " (not receiving mail)" }
    );
    println!("    {}", dim(&format!("id {}", text(domain, "id"))));
    if let Some(records) = domain.get("records") {
        for kind in ["txt", "mx"] {
            if let Some(record) = records.get(kind) {
                println!(
                    "    {}",
                    dim(&format!(
                        "{} {}  {}",
                        kind.to_uppercase(),
                        text(record, "name"),
                        text(record, "value")
                    ))
                );
            }
        }
    }
    let routes = domain
        .get("routes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for route in &routes {
        println!(
            "    {}",
            dim(&format!(
                "{}@ -> endpoint {}",
                sanitize(text(route, "localPart")),
                text(route, "endpointId")
            ))
        );
    }
    if let Some(Value::String(id)) = domain.get("catchAllEndpointId") {
        println!("    {}", dim(&format!("everything else -> endpoint {id}")));
    }
}

pub async fn domains_list(client: &ApiClient, team: Option<&str>, json: bool) -> Result<()> {
    let answer = client.list_domains(team).await?;
    if json {
        return print_json(&answer);
    }
    let list = answer
        .get("domains")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        println!("  No custom domains. Add one with `whk domains add <domain>`.");
    }
    for domain in &list {
        print_domain(domain);
    }
    Ok(())
}

pub async fn domains_add(
    client: &ApiClient,
    domain: &str,
    team: Option<&str>,
    json: bool,
) -> Result<()> {
    let answer = client.add_domain(domain, team).await?;
    if json {
        return print_json(&answer);
    }
    let added = answer.get("domain").cloned().unwrap_or(Value::Null);
    println!(
        "  {} Added. Publish these DNS records, then run `whk domains verify {}`:",
        green("✓"),
        text(&added, "id")
    );
    print_domain(&added);
    Ok(())
}

pub async fn domains_verify(
    client: &ApiClient,
    id: &str,
    team: Option<&str>,
    json: bool,
) -> Result<()> {
    let answer = client.verify_domain(id, team).await?;
    if json {
        return print_json(&answer);
    }
    let found = |kind: &str| {
        answer
            .get("records")
            .and_then(|r| r.get(kind))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let mark = |ok: bool| if ok { green("found") } else { red("missing") };
    println!("  TXT {}  MX {}", mark(found("txt")), mark(found("mx")));
    if let Some(domain) = answer.get("domain") {
        print_domain(domain);
    }
    Ok(())
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// An endpoint id, from a slug or an id.
async fn endpoint_id(client: &ApiClient, slug_or_id: &str) -> Result<String> {
    if is_uuid(slug_or_id) {
        return Ok(slug_or_id.to_string());
    }
    Ok(client.get_endpoint(slug_or_id).await?.value.id.clone())
}

pub async fn domains_route(
    client: &ApiClient,
    id: &str,
    team: Option<&str>,
    catch_all: Option<&str>,
    routes: &[String],
    json: bool,
) -> Result<()> {
    if catch_all.is_none() && routes.is_empty() {
        return Err(CliError::Usage("give --catch-all, --route, or both".into()).into());
    }
    // Only what was given changes: the rest is read back first.
    let current = client.list_domains(team).await?;
    let domain = current
        .get("domains")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|d| text(d, "id") == id))
        .cloned()
        .ok_or_else(|| {
            CliError::Usage(format!(
                "no domain {id} on this account (see `whk domains list`)"
            ))
        })?;

    let catch_all_id = match catch_all {
        None => domain
            .get("catchAllEndpointId")
            .cloned()
            .unwrap_or(Value::Null),
        Some("none") => Value::Null,
        Some(endpoint) => Value::String(endpoint_id(client, endpoint).await?),
    };
    let route_list = if routes.is_empty() {
        domain.get("routes").cloned().unwrap_or_else(|| json!([]))
    } else {
        let mut list = Vec::new();
        for route in routes {
            let Some((local, endpoint)) = route.split_once('=') else {
                return Err(CliError::Usage(format!(
                    "--route takes local=endpoint, such as billing=my-endpoint (got {route})"
                ))
                .into());
            };
            list.push(json!({
                "localPart": local,
                "endpointId": endpoint_id(client, endpoint).await?,
            }));
        }
        Value::Array(list)
    };
    let answer = client
        .route_domain(
            id,
            team,
            &json!({ "catchAllEndpointId": catch_all_id, "routes": route_list }),
        )
        .await?;
    if json {
        return print_json(&answer);
    }
    println!("  {} Routing saved", green("✓"));
    if let Some(domain) = answer.get("domain") {
        print_domain(domain);
    }
    Ok(())
}

pub async fn domains_remove(
    client: &ApiClient,
    id: &str,
    team: Option<&str>,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let answer = client.remove_domain(id, team).await?;
    let id = id.to_string();
    ask(client, answer, opts, json, move |_| {
        println!("  {} Removed domain {}", red("✓"), bold(&id));
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::{get, post};
    use std::sync::{Arc, Mutex};

    const APPROVAL: &str = "0b8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";
    const DOMAIN: &str = "1c8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";
    const CATCH_ALL: &str = "2d8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";
    const BILLING: &str = "3e8d6a5e-1c2f-4f3a-9d7e-2a1b3c4d5e6f";

    fn approval(status: &str) -> Value {
        json!({
            "id": APPROVAL,
            "status": status,
            "action": "request_shares.create",
            "summary": "Publish a read-only copy of the request POST /hook at a public link for 7 days.",
            "code": "ABCD-EFGH",
            "url": "https://webhooks.cc/approve?code=ABCD-EFGH",
            "expiresAt": "2026-11-13T12:15:00.000Z",
        })
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    fn client(base: &str) -> ApiClient {
        ApiClient::with_credentials(Some(base), Some(base), Some("whcc_test".into()), None).unwrap()
    }

    fn options() -> ApprovalOptions {
        ApprovalOptions {
            remote: true,
            no_browser: true,
            no_wait: false,
            timeout: "1m".into(),
        }
    }

    #[tokio::test]
    async fn a_share_link_is_asked_for_then_read_once_approved() {
        let asked: Arc<Mutex<Option<Value>>> = Arc::default();
        let seen = asked.clone();
        let polls = Arc::new(Mutex::new(0usize));
        let app = Router::new()
            .route(
                "/api/requests/{id}/shares",
                post(move |axum::Json(body): axum::Json<Value>| async move {
                    *seen.lock().unwrap() = Some(body);
                    (
                        axum::http::StatusCode::ACCEPTED,
                        axum::Json(json!({ "approval": approval("pending") })),
                    )
                }),
            )
            .route(
                "/api/approvals/{id}",
                get(move || {
                    let polls = polls.clone();
                    async move {
                        let mut n = polls.lock().unwrap();
                        *n += 1;
                        if *n < 2 {
                            return axum::Json(json!({ "approval": approval("pending") }));
                        }
                        // An approve-time action: done when approved, its
                        // result on every poll.
                        axum::Json(json!({
                            "approval": approval("completed"),
                            "result": {
                                "id": "s1", "url": "https://webhooks.cc/s/abc",
                                "expiresAt": "2026-11-20T12:00:00.000Z", "redactedHeaders": [],
                            },
                        }))
                    }
                }),
            );
        let base = serve(app).await;
        share_links_create(&client(&base), "req-1", 30, false, options(), true)
            .await
            .unwrap();
        assert_eq!(
            asked.lock().unwrap().clone().unwrap(),
            json!({ "expiresInDays": 30, "hideSensitive": true })
        );
    }

    #[tokio::test]
    async fn routing_keeps_the_catch_all_when_only_routes_change() {
        let sent: Arc<Mutex<Option<Value>>> = Arc::default();
        let seen = sent.clone();
        let app = Router::new()
            .route(
                "/api/domains",
                get(|| async {
                    axum::Json(json!({ "domains": [{
                        "id": DOMAIN, "domain": "mail.example.com", "status": "verified",
                        "catchAllEndpointId": CATCH_ALL, "routes": [], "active": true,
                    }] }))
                }),
            )
            .route(
                "/api/endpoints/{slug}",
                get(|| async { axum::Json(json!({ "id": BILLING, "slug": "billing-hook" })) }),
            )
            .route(
                "/api/domains/{id}",
                axum::routing::patch(move |axum::Json(body): axum::Json<Value>| async move {
                    *seen.lock().unwrap() = Some(body);
                    axum::Json(json!({ "domain": { "id": DOMAIN } }))
                }),
            );
        let base = serve(app).await;
        domains_route(
            &client(&base),
            DOMAIN,
            None,
            None,
            &["billing=billing-hook".to_string()],
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            sent.lock().unwrap().clone().unwrap(),
            json!({
                "catchAllEndpointId": CATCH_ALL,
                "routes": [{ "localPart": "billing", "endpointId": BILLING }],
            })
        );
    }

    #[tokio::test]
    async fn routing_needs_something_to_change() {
        let error = domains_route(&client("http://127.0.0.1:9"), DOMAIN, None, None, &[], true)
            .await
            .unwrap_err();
        assert_eq!(crate::error::classify(&error).code, "usage");
    }
}
