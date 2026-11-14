//! Dry runs of what an endpoint does with a capture, with its saved
//! settings or ones you are about to save: `whk mock preview` (which
//! response a sender gets back) and `whk layouts preview` (what the email
//! layouts read). Nothing is saved, sent or charged.

use anyhow::Result;
use serde_json::{Map, Value, json};

use crate::api::ApiClient;
use crate::cli::destinations::json_arg;
use crate::cli::output::{bold, dim, parsed_section, red, sanitize_line};
use crate::error::CliError;
use crate::types::ParsedEmail;

fn print_json(answer: &crate::api::client::Fetched<Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&answer.json())?);
    Ok(())
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

/// The body for `whk mock preview`: a request, and unsaved settings to try.
pub fn response_body(
    request: Option<&str>,
    mock_response: Option<&str>,
    response_rules: Option<&str>,
) -> Result<Value> {
    let mut body = Map::new();
    if let Some(request) = request {
        body.insert("requestId".into(), json!(request.trim()));
    }
    if let Some(mock) = mock_response {
        let mock = json_arg("--mock-response", mock)?;
        if !(mock.is_null() || mock.is_object()) {
            return Err(CliError::Usage(
                "--mock-response takes an object, {\"status\": 200, \"body\": \"...\", \"headers\": {}}, or null".into(),
            )
            .into());
        }
        body.insert("mockResponse".into(), mock);
    }
    if let Some(rules) = response_rules {
        let rules = json_arg("--response-rules", rules)?;
        if !(rules.is_null() || rules.is_array()) {
            return Err(CliError::Usage(
                "--response-rules takes a JSON list of rules, or null for none".into(),
            )
            .into());
        }
        body.insert("responseRules".into(), rules);
    }
    Ok(Value::Object(body))
}

fn request_label(request: &Value) -> String {
    let what = format!(
        "{} {}",
        sanitize_line(text(request, "method")),
        sanitize_line(text(request, "path"))
    );
    if request.get("sample").and_then(Value::as_bool) == Some(true) || request["id"].is_null() {
        format!(
            "{what} {}",
            dim("(a sample: no HTTP request was captured yet)")
        )
    } else {
        format!("{what} {}", dim(text(request, "id")))
    }
}

fn response_lines(answer: &Value) -> Vec<String> {
    let label = |name: &str| dim(&format!("{name:<9}"));
    let mut out = Vec::new();
    if let Some(request) = answer.get("request") {
        out.push(format!("  {} {}", label("For"), request_label(request)));
    }
    if answer.get("email").and_then(Value::as_bool) == Some(true) {
        out.push(format!(
            "  {} an email gets the mail server's standard reply, never a mock response",
            label("Answer")
        ));
        return out;
    }
    let chosen = match answer.get("rule").filter(|r| !r.is_null()) {
        Some(rule) => {
            let n = rule.get("index").and_then(Value::as_u64).unwrap_or(0) + 1;
            match rule.get("name").and_then(Value::as_str) {
                Some(name) => format!("rule {n} \"{}\"", sanitize_line(name)),
                None => format!("rule {n}"),
            }
        }
        None => "the default response (no rule matched)".into(),
    };
    out.push(format!("  {} {chosen}", label("Chosen")));
    match answer.get("response").filter(|r| !r.is_null()) {
        None => out.push(format!(
            "  {} 200 OK, the receiver's plain answer (no mock response is set)",
            label("Answer")
        )),
        Some(response) => {
            let status = response.get("status").and_then(Value::as_u64).unwrap_or(0);
            let delay = response.get("delay").and_then(Value::as_u64).unwrap_or(0);
            let mut line = format!("  {} {}", label("Answer"), bold(&status.to_string()));
            if delay > 0 {
                line.push_str(&dim(&format!(" after {delay} ms")));
            }
            out.push(line);
            if let Some(headers) = response.get("headers").and_then(Value::as_object) {
                for (name, value) in headers {
                    out.push(format!(
                        "  {}: {}",
                        dim(&sanitize_line(name)),
                        sanitize_line(value.as_str().unwrap_or(""))
                    ));
                }
            }
            let body = text(response, "body");
            if !body.is_empty() {
                out.push(String::new());
                for line in body.lines() {
                    out.push(format!("  {}", sanitize_line(line)));
                }
            }
        }
    }
    for placeholder in answer
        .get("unknownPlaceholders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.push(format!(
            "  {} {{{{ {} }}}} has nothing in this request to fill it: it is sent as written",
            red("!"),
            sanitize_line(placeholder)
        ));
    }
    out.push(String::new());
    out.push(format!("  {}", dim("A dry run: nothing was sent.")));
    out
}

pub async fn response(
    client: &ApiClient,
    slug: &str,
    request: Option<&str>,
    mock_response: Option<&str>,
    response_rules: Option<&str>,
    json: bool,
) -> Result<()> {
    let body = response_body(request, mock_response, response_rules)?;
    let answer = client.preview_response(slug, &body).await?;
    if json {
        return print_json(&answer);
    }
    for line in response_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

/// The body for `whk layouts preview`: an email, and unsaved layouts to try.
pub fn layouts_body(request: Option<&str>, layouts: Option<&str>) -> Result<Value> {
    let mut body = Map::new();
    if let Some(request) = request {
        body.insert("requestId".into(), json!(request.trim()));
    }
    if let Some(layouts) = layouts {
        let layouts = json_arg("--layouts", layouts)?;
        if !layouts.is_array() {
            return Err(CliError::Usage("--layouts takes a JSON list of layouts".into()).into());
        }
        body.insert("layouts".into(), layouts);
    }
    Ok(Value::Object(body))
}

fn layouts_lines(answer: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let problems: Vec<&str> = answer
        .get("problems")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    for problem in &problems {
        out.push(format!("  {} {}", red("!"), sanitize_line(problem)));
    }
    let Some(request) = answer.get("request").filter(|r| !r.is_null()) else {
        out.push("  No captured email on this endpoint to try the layouts on.".into());
        return out;
    };
    let subject = request
        .get("subject")
        .and_then(Value::as_str)
        .unwrap_or("(no subject)");
    out.push(format!(
        "  {} {}",
        bold(&sanitize_line(subject)),
        dim(text(request, "id"))
    ));
    if !problems.is_empty() {
        out.push(format!(
            "  {}",
            dim("The layouts given have problems, so none ran.")
        ));
    } else {
        let parsed = answer
            .get("parsed")
            .filter(|p| !p.is_null())
            .and_then(|p| serde_json::from_value::<ParsedEmail>(p.clone()).ok());
        match parsed {
            Some(parsed) if parsed.status != "no_layout" => {
                out.extend(parsed_section(Some(&parsed)));
            }
            Some(_) => out.push("  No layout matches this email.".into()),
            None => {
                out.push("  No layouts to run: the endpoint has none, and none were given.".into())
            }
        }
    }
    if let Some(cap) = answer.get("layoutsCap").and_then(Value::as_u64) {
        out.push(format!(
            "  {}",
            dim(&format!(
                "The plan matches the first {cap} layout{}.",
                if cap == 1 { "" } else { "s" }
            ))
        ));
    }
    out.push(format!(
        "  {}",
        dim("A dry run: nothing was saved, and no pages were used.")
    ));
    out
}

pub async fn layouts(
    client: &ApiClient,
    slug: &str,
    request: Option<&str>,
    layouts: Option<&str>,
    json: bool,
) -> Result<()> {
    let body = layouts_body(request, layouts)?;
    let answer = client.preview_layouts(slug, &body).await?;
    if json {
        return print_json(&answer);
    }
    for line in layouts_lines(&answer.value) {
        println!("{line}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;

    #[test]
    fn a_response_preview_sends_only_what_was_given() {
        assert_eq!(response_body(None, None, None).unwrap(), json!({}));
        let body = response_body(
            Some(" r1 "),
            Some(r#"{"status":201,"body":"{{ json.id }}","headers":{}}"#),
            Some("null"),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({
                "requestId": "r1",
                "mockResponse": { "status": 201, "body": "{{ json.id }}", "headers": {} },
                "responseRules": null
            })
        );
    }

    #[test]
    fn response_settings_must_have_their_shape() {
        for (mock, rules) in [
            (Some("[1]"), None),
            (None, Some("{}")),
            (Some("nope"), None),
        ] {
            let error = response_body(None, mock, rules).unwrap_err();
            assert_eq!(classify(&error).code, "usage");
        }
    }

    #[test]
    fn shows_the_chosen_rule_and_its_answer() {
        let lines = response_lines(&json!({
            "rule": { "index": 1, "name": "refunds" },
            "response": { "status": 409, "headers": { "x-why": "dup" }, "body": "{\"ok\":false}", "delay": 250 },
            "unknownPlaceholders": ["json.missing"],
            "email": false,
            "request": { "id": "r1", "method": "POST", "path": "/hook", "receivedAt": 0, "sample": false }
        }))
        .join("\n");
        assert!(lines.contains("rule 2 \"refunds\""), "{lines}");
        assert!(lines.contains("409"), "{lines}");
        assert!(lines.contains("after 250 ms"), "{lines}");
        assert!(lines.contains("x-why"), "{lines}");
        assert!(lines.contains("{{ json.missing }}"), "{lines}");
        assert!(lines.contains("nothing was sent"), "{lines}");
    }

    #[test]
    fn says_when_the_plain_answer_or_a_sample_is_used() {
        let lines = response_lines(&json!({
            "rule": null, "response": null, "unknownPlaceholders": [], "email": false,
            "request": { "id": null, "method": "POST", "path": "/", "receivedAt": 0, "sample": true }
        }))
        .join("\n");
        assert!(lines.contains("200 OK"), "{lines}");
        assert!(lines.contains("a sample"), "{lines}");
    }

    #[test]
    fn a_crafted_path_stays_on_one_line() {
        let lines = response_lines(&json!({
            "rule": null, "response": null, "unknownPlaceholders": [], "email": false,
            "request": { "id": "r1", "method": "POST", "path": "/a\n  Answer 500", "receivedAt": 0 }
        }));
        assert!(
            lines[0].contains("/a   Answer 500") && !lines[0].contains('\n'),
            "{lines:?}"
        );
    }

    #[test]
    fn a_layouts_preview_takes_a_list() {
        assert_eq!(layouts_body(None, None).unwrap(), json!({}));
        let body = layouts_body(Some("r1"), Some(r#"[{"name":"orders"}]"#)).unwrap();
        assert_eq!(body["layouts"][0]["name"], "orders");
        let error = layouts_body(None, Some(r#"{"name":"orders"}"#)).unwrap_err();
        assert_eq!(classify(&error).code, "usage");
    }

    #[test]
    fn shows_what_the_layouts_find() {
        let lines = layouts_lines(&json!({
            "problems": [],
            "layoutsCap": 5,
            "request": { "id": "r1", "subject": "Order #1001", "receivedAt": 0 },
            "parsed": {
                "status": "matched",
                "layout": { "id": "l1", "name": "Shop orders" },
                "fields": { "order": "1001" },
                "lineItems": [], "lineItemColumns": [], "attachments": [], "pages": 0
            }
        }))
        .join("\n");
        assert!(lines.contains("Order #1001"), "{lines}");
        assert!(lines.contains("1001"), "{lines}");
        assert!(lines.contains("first 5 layouts"), "{lines}");
    }

    #[test]
    fn says_when_nothing_matches_or_the_layouts_are_wrong() {
        let request = json!({ "id": "r1", "subject": "Hi", "receivedAt": 0 });
        let none = layouts_lines(&json!({
            "problems": [], "layoutsCap": 5, "request": request,
            "parsed": { "status": "no_layout", "fields": {} }
        }))
        .join("\n");
        assert!(none.contains("No layout matches"), "{none}");
        let wrong = layouts_lines(&json!({
            "problems": ["layout 1: a name is required"], "layoutsCap": 5,
            "request": request, "parsed": null
        }))
        .join("\n");
        assert!(wrong.contains("a name is required"), "{wrong}");
        assert!(wrong.contains("none ran"), "{wrong}");
        let empty = layouts_lines(&json!({ "problems": [], "request": null, "parsed": null }));
        assert!(empty.join("\n").contains("No captured email"));
    }
}
