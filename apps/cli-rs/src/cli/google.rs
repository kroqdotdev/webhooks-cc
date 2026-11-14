//! `whk google` and `whk ai`: Google accounts for Sheets destinations, and AI
//! setup for an endpoint's email fields. Listing, tabs, new spreadsheets and
//! disconnecting act at once. Connecting an account, choosing a spreadsheet
//! from Drive and AI setup are the account owner's to allow: whk prints the
//! approval link, the page takes them to Google (or lists the emails that
//! would go to the model), and whk prints what came back.

use anyhow::Result;
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::account::{ApprovalOptions, ask, print_json, text, when};
use crate::cli::output::{bold, dim, green, red, sanitize};
use crate::error::CliError;

pub async fn list(client: &ApiClient, json: bool) -> Result<()> {
    let answer = client.google_connections().await?;
    if json {
        return print_json(&answer);
    }
    if answer.get("available").and_then(Value::as_bool) == Some(false) {
        println!("  Google Sheets is not set up on this server.");
        return Ok(());
    }
    let list = answer
        .get("connections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        println!("  No Google accounts. Connect one with `whk google connect`.");
    }
    for connection in &list {
        let email = connection
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("Google account");
        println!("  {}", bold(&sanitize(email)));
        println!(
            "    {}",
            dim(&format!(
                "id {}  connected {}",
                text(connection, "id"),
                when(connection, "createdAt")
            ))
        );
    }
    Ok(())
}

fn browser_session_refusal() -> anyhow::Error {
    CliError::Usage("a browser session does this in the dashboard; whk uses an API key".into())
        .into()
}

pub async fn connect(client: &ApiClient, opts: ApprovalOptions, json: bool) -> Result<()> {
    let answer = client.google_connect().await?;
    ask(client, answer, opts, json, |_| {
        eprintln!("{}", browser_session_refusal())
    })
    .await
}

pub async fn pick(
    client: &ApiClient,
    connection_id: &str,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    let answer = client.google_pick(connection_id).await?;
    ask(client, answer, opts, json, |_| {
        eprintln!("{}", browser_session_refusal())
    })
    .await
}

pub async fn tabs(
    client: &ApiClient,
    connection_id: &str,
    spreadsheet_id: &str,
    json: bool,
) -> Result<()> {
    let answer = client.google_tabs(connection_id, spreadsheet_id).await?;
    if json {
        return print_json(&answer);
    }
    for tab in answer
        .get("tabs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        println!("  {}", sanitize(tab.as_str().unwrap_or("")));
    }
    Ok(())
}

pub struct SheetOptions {
    pub title: Option<String>,
    pub spreadsheet_id: Option<String>,
    pub sheet: Option<String>,
    pub headers: Vec<String>,
}

pub async fn create_sheet(
    client: &ApiClient,
    connection_id: &str,
    opts: SheetOptions,
    json: bool,
) -> Result<()> {
    if opts.headers.is_empty() {
        return Err(
            CliError::Usage("give the header row with --header, once per column".into()).into(),
        );
    }
    let mut input = json!({ "connectionId": connection_id, "headers": opts.headers });
    if let Some(title) = opts.title {
        input["title"] = json!(title);
    }
    if let Some(id) = opts.spreadsheet_id {
        input["spreadsheetId"] = json!(id);
    }
    if let Some(sheet) = opts.sheet {
        input["sheet"] = json!(sheet);
    }
    let answer = client.google_create_spreadsheet(&input).await?;
    if json {
        return print_json(&answer);
    }
    match answer.get("headerWritten").and_then(Value::as_bool) {
        Some(false) => {
            println!("  The first row already holds something else, so it was left as it is.")
        }
        Some(true) => println!("  {} Header row written", green("✓")),
        None => {
            println!("  {} Spreadsheet created", green("✓"));
            println!("    {}", bold(text(&answer, "url")));
            println!("    {}", dim(&format!("id {}", text(&answer, "id"))));
        }
    }
    Ok(())
}

pub async fn disconnect(
    client: &ApiClient,
    connection_id: &str,
    yes: bool,
    json: bool,
) -> Result<()> {
    crate::cli::confirm::confirm(
        &format!(
            "Disconnect Google account {connection_id}? Sheets destinations using it fail until another is chosen."
        ),
        yes,
    )?;
    client.google_disconnect(connection_id).await?;
    if json {
        println!("{}", json!({ "disconnected": connection_id }));
    } else {
        println!(
            "  {} Disconnected Google account {}",
            red("✓"),
            bold(connection_id)
        );
    }
    Ok(())
}

pub async fn ai_status(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let answer = client.ai_status(slug).await?;
    if json {
        return print_json(&answer);
    }
    if answer.get("offered").and_then(Value::as_bool) != Some(true) {
        println!("  AI setup is not offered on this server.");
        return Ok(());
    }
    let n = |field: &str| answer.get(field).and_then(Value::as_i64).unwrap_or(0);
    println!(
        "  {} of {} AI assists used in the last 30 days",
        n("used"),
        n("allowed")
    );
    if answer.get("nextAt").and_then(Value::as_str).is_some() {
        println!(
            "  {}",
            dim(&format!(
                "The next one comes back {}",
                when(&answer, "nextAt")
            ))
        );
    }
    Ok(())
}

pub struct SetupAsk {
    pub field: Option<String>,
    pub description: Option<String>,
    pub layout: bool,
    pub repair: Option<String>,
}

fn setup_ask(input: SetupAsk) -> Result<Value> {
    match (input.field, input.layout, input.repair) {
        (Some(name), false, None) => {
            let description = input.description.ok_or_else(|| {
                CliError::Usage("--field needs --description, saying what the field is".into())
            })?;
            Ok(json!({ "kind": "field", "name": name, "description": description }))
        }
        (None, true, None) => Ok(json!({
            "kind": "layout",
            "description": input.description.unwrap_or_default(),
        })),
        (None, false, Some(field)) => {
            let field: Value = serde_json::from_str(&field).map_err(|_| {
                CliError::Usage(
                    "--repair takes the field as JSON: {\"name\", \"from\", \"pattern\"}".into(),
                )
            })?;
            Ok(json!({ "kind": "repair", "field": field }))
        }
        _ => Err(CliError::Usage(
            "give one of --field <name> (with --description), --layout or --repair <json>".into(),
        )
        .into()),
    }
}

pub async fn ai_setup(
    client: &ApiClient,
    slug: &str,
    request_ids: &[String],
    setup: SetupAsk,
    opts: ApprovalOptions,
    json: bool,
) -> Result<()> {
    if request_ids.is_empty() || request_ids.len() > 5 {
        return Err(
            CliError::Usage("give 1 to 5 of the endpoint's emails with --request".into()).into(),
        );
    }
    let ask_value = setup_ask(setup)?;
    let answer = client
        .ai_setup(
            slug,
            &json!({ "ask": ask_value, "requestIds": request_ids }),
        )
        .await?;
    ask(client, answer, opts, json, |done| {
        println!(
            "{}",
            sanitize(&serde_json::to_string_pretty(done).unwrap_or_default())
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_each_kind_of_ask() {
        let field = setup_ask(SetupAsk {
            field: Some("order".into()),
            description: Some("the order number".into()),
            layout: false,
            repair: None,
        })
        .unwrap();
        assert_eq!(
            field,
            json!({ "kind": "field", "name": "order", "description": "the order number" })
        );
        let layout = setup_ask(SetupAsk {
            field: None,
            description: None,
            layout: true,
            repair: None,
        })
        .unwrap();
        assert_eq!(layout, json!({ "kind": "layout", "description": "" }));
        let repair = setup_ask(SetupAsk {
            field: None,
            description: None,
            layout: false,
            repair: Some(r##"{"name":"order","from":"subject","pattern":"#(\\d+)"}"##.into()),
        })
        .unwrap();
        assert_eq!(repair["field"]["from"], "subject");
    }

    #[test]
    fn needs_exactly_one_kind() {
        for bad in [
            SetupAsk {
                field: None,
                description: None,
                layout: false,
                repair: None,
            },
            SetupAsk {
                field: Some("a".into()),
                description: Some("x".into()),
                layout: true,
                repair: None,
            },
            SetupAsk {
                field: Some("a".into()),
                description: None,
                layout: false,
                repair: None,
            },
        ] {
            let error = setup_ask(bad).unwrap_err();
            assert_eq!(crate::error::classify(&error).code, "usage");
        }
    }
}
