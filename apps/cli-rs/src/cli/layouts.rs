//! `whk layouts` and `whk fields`: the ready-made email layouts an endpoint
//! can take, adding one, and a dry run of its named email fields. Saving
//! layouts and fields of your own is an endpoint update (`whk api`), and AI
//! setup proposes them (`whk ai setup`).

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::api::ApiClient;
use crate::cli::output::{bold, dim, green, sanitize};
use crate::error::CliError;

pub async fn templates(client: &ApiClient, slug: &str, json: bool) -> Result<()> {
    let answer = client.layout_templates(slug).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.json())?);
        return Ok(());
    }
    let list = answer
        .value
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        println!("  No ready-made layouts.");
        return Ok(());
    }
    for template in &list {
        for line in template_lines(template) {
            println!("{line}");
        }
    }
    println!(
        "\n  {} whk layouts add-template {} <id>",
        dim("Add one:"),
        sanitize(slug)
    );
    Ok(())
}

fn template_lines(t: &Value) -> Vec<String> {
    let text = |field: &str| sanitize(t.get(field).and_then(Value::as_str).unwrap_or(""));
    let fields = t
        .get("fields")
        .and_then(Value::as_array)
        .map(|f| {
            f.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut reads = sanitize(&fields);
    if t.get("lineItems").and_then(Value::as_bool) == Some(true) {
        if !reads.is_empty() {
            reads.push_str(", ");
        }
        reads.push_str("line items");
    }
    vec![
        format!(
            "  {}  {} {}",
            bold(&text("id")),
            text("sender"),
            dim(&text("kind"))
        ),
        format!("    {}", text("description")),
        format!("    {}", dim(&format!("reads: {reads}"))),
    ]
}

pub async fn add_template(
    client: &ApiClient,
    slug: &str,
    template: &str,
    json: bool,
) -> Result<()> {
    let answer = client.add_layout_template(slug, template.trim()).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.json())?);
        return Ok(());
    }
    let id = answer
        .value
        .get("layoutId")
        .and_then(Value::as_str)
        .unwrap_or("");
    println!(
        "{} Added layout {} to {}",
        green("✓"),
        bold(&sanitize(id)),
        bold(&sanitize(slug))
    );
    println!(
        "{}",
        dim(
            "Emails it matches are parsed from the next one on; it sits after the endpoint's other layouts."
        )
    );
    Ok(())
}

/// `--fields`: the fields as JSON text, or `@file`.
fn read_fields(fields: &str) -> Result<Value> {
    let text = match fields.strip_prefix('@') {
        Some("") => {
            return Err(CliError::Usage("--fields @ needs a file name".into()).into());
        }
        Some(file) => {
            std::fs::read_to_string(file).with_context(|| format!("failed to read {file}"))?
        }
        None => fields.to_string(),
    };
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        CliError::Usage(
            "--fields takes a JSON list of fields, [{\"name\", \"from\", \"pattern\"}], or @file"
                .into(),
        )
    })?;
    if !value.is_array() {
        return Err(CliError::Usage(
            "--fields takes a JSON list of fields, [{\"name\", \"from\", \"pattern\"}]".into(),
        )
        .into());
    }
    Ok(value)
}

fn preview_body(request: Option<&str>, fields: Option<&str>) -> Result<Value> {
    let mut body = json!({});
    if let Some(request) = request {
        body["requestId"] = json!(request.trim());
    }
    if let Some(fields) = fields {
        body["emailFields"] = read_fields(fields)?;
    }
    Ok(body)
}

pub async fn preview(
    client: &ApiClient,
    slug: &str,
    request: Option<&str>,
    fields: Option<&str>,
    json: bool,
) -> Result<()> {
    let body = preview_body(request, fields)?;
    let answer = client.preview_email_fields(slug, &body).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&answer.json())?);
        return Ok(());
    }
    for line in preview_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

fn preview_lines(answer: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for problem in answer
        .get("problems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.push(format!("  ! {}", sanitize(problem)));
    }
    let Some(request) = answer.get("request").filter(|r| !r.is_null()) else {
        out.push("  No captured email on this endpoint to try the fields on.".into());
        return out;
    };
    let subject = request
        .get("subject")
        .and_then(Value::as_str)
        .unwrap_or("(no subject)");
    out.push(format!(
        "  {} {}",
        bold(&sanitize(subject)),
        dim(request.get("id").and_then(Value::as_str).unwrap_or(""))
    ));
    match answer.get("values").and_then(Value::as_object) {
        Some(values) if !values.is_empty() => {
            for (name, value) in values {
                let shown = match value.as_str() {
                    Some(v) => sanitize(v),
                    None => dim("(nothing found)"),
                };
                out.push(format!("    {}: {shown}", sanitize(name)));
            }
        }
        _ => out
            .push("    No fields to try: the endpoint has none saved, and none were given.".into()),
    }
    out.push(format!("  {}", dim("A dry run: nothing is saved.")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_sends_only_what_was_given() {
        assert_eq!(preview_body(None, None).unwrap(), json!({}));
        let body = preview_body(
            Some("req-1"),
            Some(r##"[{"name":"order","from":"subject","pattern":"#(\\d+)"}]"##),
        )
        .unwrap();
        assert_eq!(body["requestId"], "req-1");
        assert_eq!(body["emailFields"][0]["name"], "order");
    }

    #[test]
    fn fields_must_be_a_json_list() {
        for bad in ["{\"name\":\"order\"}", "not json", "@"] {
            let error = preview_body(None, Some(bad)).unwrap_err();
            assert_eq!(crate::error::classify(&error).code, "usage", "{bad}");
        }
    }

    #[test]
    fn shows_found_and_missing_values() {
        let lines = preview_lines(&json!({
            "problems": ["field 2: pattern does not compile"],
            "request": { "id": "r1", "subject": "Order #1001", "receivedAt": 0 },
            "values": { "order": "1001", "total": null }
        }))
        .join("\n");
        assert!(
            lines.contains("field 2: pattern does not compile"),
            "{lines}"
        );
        assert!(lines.contains("Order #1001"), "{lines}");
        assert!(lines.contains("order: 1001"), "{lines}");
        assert!(
            lines.contains("total:") && lines.contains("nothing found"),
            "{lines}"
        );
    }

    #[test]
    fn says_when_there_is_no_email() {
        let lines = preview_lines(&json!({ "problems": [], "request": null, "values": null }));
        assert!(lines.join("\n").contains("No captured email"));
    }

    #[test]
    fn lists_what_a_template_reads() {
        let lines = template_lines(&json!({
            "id": "shopify-order", "sender": "Shopify", "kind": "order notifications",
            "description": "New orders.", "fields": ["order", "total"], "lineItems": true
        }))
        .join("\n");
        assert!(lines.contains("shopify-order"));
        assert!(lines.contains("reads: order, total, line items"));
    }
}
