//! Conditional response rule evaluation engine.
//!
//! Evaluates an ordered list of rules against an incoming request.
//! First matching rule wins. Returns `None` if no rules match (caller
//! falls back to the default mock_response or 200 OK).

use serde::Deserialize;
use std::collections::HashMap;

use super::webhook::MockResponse;

/// A single condition within a response rule.
#[derive(Debug, Deserialize, Clone)]
pub struct RuleCondition {
    /// Field to match against: method, path, header, body_contains, body_path, query
    pub field: String,
    /// Operator: eq, contains, starts_with, matches, exists
    pub op: String,
    /// Value to compare against (not required for "exists")
    #[serde(default)]
    pub value: Option<String>,
    /// Header name or query param name
    #[serde(default)]
    pub name: Option<String>,
    /// JSON dot-notation path for body_path conditions
    #[serde(default)]
    pub path: Option<String>,
}

/// A conditional response rule with conditions and a response to return on match.
#[derive(Debug, Deserialize, Clone)]
pub struct ResponseRule {
    /// Unique identifier for UI reference
    #[serde(default)]
    #[allow(dead_code)]
    pub id: Option<String>,
    /// Human-readable name
    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
    /// Whether this rule is active (default: true)
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How to combine conditions: "and" (default) or "or"
    #[serde(default = "default_and")]
    pub logic: String,
    /// Conditions to evaluate
    pub conditions: Vec<RuleCondition>,
    /// Response to return when conditions match
    pub response: MockResponse,
}

fn default_true() -> bool {
    true
}

fn default_and() -> String {
    "and".to_string()
}

/// Request context passed to the rule evaluator.
pub struct RequestContext<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: &'a HashMap<String, String>,
    pub body: &'a str,
    pub query: &'a HashMap<String, String>,
}

/// Evaluate rules in order. Returns the response from the first matching rule,
/// or `None` if no rules match.
pub fn evaluate_rules(rules: &[ResponseRule], ctx: &RequestContext<'_>) -> Option<MockResponse> {
    // Lazily parse body as JSON only when a body_path condition needs it
    let mut parsed_body: Option<serde_json::Value> = None;

    for rule in rules {
        if !rule.enabled || rule.conditions.is_empty() {
            continue;
        }

        let is_or = rule.logic == "or";
        let matched = if is_or {
            rule.conditions
                .iter()
                .any(|c| evaluate_condition(c, ctx, &mut parsed_body))
        } else {
            rule.conditions
                .iter()
                .all(|c| evaluate_condition(c, ctx, &mut parsed_body))
        };

        if matched {
            return Some(rule.response.clone());
        }
    }

    None
}

/// Evaluate a single condition against the request context.
fn evaluate_condition(
    condition: &RuleCondition,
    ctx: &RequestContext<'_>,
    parsed_body: &mut Option<serde_json::Value>,
) -> bool {
    match condition.field.as_str() {
        "method" => eval_method(condition, ctx.method),
        "path" => eval_path(condition, ctx.path),
        "header" => eval_header(condition, ctx.headers),
        "body_contains" => eval_body_contains(condition, ctx.body),
        "body_path" => eval_body_path(condition, ctx.body, parsed_body),
        "query" => eval_query(condition, ctx.query),
        _ => false, // Unknown field type — skip
    }
}

fn eval_method(condition: &RuleCondition, method: &str) -> bool {
    let value = match &condition.value {
        Some(v) => v,
        None => return false,
    };
    match condition.op.as_str() {
        "eq" => method.eq_ignore_ascii_case(value),
        _ => false,
    }
}

fn eval_path(condition: &RuleCondition, path: &str) -> bool {
    let value = match &condition.value {
        Some(v) => v,
        None => return condition.op == "exists",
    };
    match condition.op.as_str() {
        "eq" => path == value.as_str(),
        "contains" => path.contains(value.as_str()),
        "starts_with" => path.starts_with(value.as_str()),
        "matches" => glob_match(value, path),
        _ => false,
    }
}

fn eval_header(condition: &RuleCondition, headers: &HashMap<String, String>) -> bool {
    let name = match &condition.name {
        Some(n) => n.to_lowercase(),
        None => return false,
    };
    // Case-insensitive header lookup
    let header_value = headers
        .iter()
        .find(|(k, _)| k.to_lowercase() == name)
        .map(|(_, v)| v.as_str());

    match condition.op.as_str() {
        "exists" => header_value.is_some(),
        "eq" => {
            let value = match &condition.value {
                Some(v) => v,
                None => return false,
            };
            header_value.is_some_and(|hv| hv == value.as_str())
        }
        "contains" => {
            let value = match &condition.value {
                Some(v) => v,
                None => return false,
            };
            header_value.is_some_and(|hv| hv.contains(value.as_str()))
        }
        _ => false,
    }
}

fn eval_body_contains(condition: &RuleCondition, body: &str) -> bool {
    let value = match &condition.value {
        Some(v) => v,
        None => return false,
    };
    match condition.op.as_str() {
        "contains" => body.contains(value.as_str()),
        _ => false,
    }
}

fn eval_body_path(
    condition: &RuleCondition,
    body: &str,
    parsed_body: &mut Option<serde_json::Value>,
) -> bool {
    let json_path = match &condition.path {
        Some(p) => p,
        None => return false,
    };

    // Lazily parse body JSON
    if parsed_body.is_none() {
        *parsed_body = serde_json::from_str(body).ok();
    }

    let root = match parsed_body {
        Some(v) => v,
        None => return false, // Body is not valid JSON
    };

    let leaf = walk_json_path(root, json_path);

    match condition.op.as_str() {
        "exists" => leaf.is_some(),
        "eq" => {
            let value = match &condition.value {
                Some(v) => v,
                None => return false,
            };
            leaf.is_some_and(|v| json_value_to_string(v) == *value)
        }
        "contains" => {
            let value = match &condition.value {
                Some(v) => v,
                None => return false,
            };
            leaf.is_some_and(|v| json_value_to_string(v).contains(value.as_str()))
        }
        _ => false,
    }
}

fn eval_query(condition: &RuleCondition, query: &HashMap<String, String>) -> bool {
    let name = match &condition.name {
        Some(n) => n,
        None => return false,
    };
    let param_value = query.get(name.as_str());

    match condition.op.as_str() {
        "exists" => param_value.is_some(),
        "eq" => {
            let value = match &condition.value {
                Some(v) => v,
                None => return false,
            };
            param_value.is_some_and(|pv| pv == value.as_str())
        }
        _ => false,
    }
}

/// Walk a dot-notation JSON path like "data.object.type" and return the leaf value.
/// Supports array index access via numeric segments (e.g. "items.0.name").
fn walk_json_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        match current {
            serde_json::Value::Object(map) => {
                current = map.get(segment)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = segment.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

/// Convert a JSON value to its string representation for comparison.
/// Strings are returned without quotes; other types use their JSON representation.
fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// Simple glob pattern matching.
/// Supports `*` (any characters except `/`) and `**` (any characters including `/`).
fn glob_match(pattern: &str, input: &str) -> bool {
    let regex_str = glob_to_regex(pattern);
    regex_lite::Regex::new(&regex_str).is_ok_and(|re| re.is_match(input))
}

/// Convert a glob pattern to a regex string.
fn glob_to_regex(pattern: &str) -> String {
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            regex.push_str(".*");
            i += 2;
            // Skip trailing slash after **
            if i < chars.len() && chars[i] == '/' {
                i += 1;
            }
        } else if chars[i] == '*' {
            regex.push_str("[^/]*");
            i += 1;
        } else if chars[i] == '?' {
            regex.push_str("[^/]");
            i += 1;
        } else {
            // Escape regex special characters
            if "\\^$.|+()[]{}".contains(chars[i]) {
                regex.push('\\');
            }
            regex.push(chars[i]);
            i += 1;
        }
    }
    regex.push('$');
    regex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx<'a>(
        method: &'a str,
        path: &'a str,
        headers: &'a HashMap<String, String>,
        body: &'a str,
        query: &'a HashMap<String, String>,
    ) -> RequestContext<'a> {
        RequestContext {
            method,
            path,
            headers,
            body,
            query,
        }
    }

    fn make_rule(
        conditions: Vec<RuleCondition>,
        status: i64,
        body: &str,
        logic: &str,
    ) -> ResponseRule {
        ResponseRule {
            id: None,
            name: None,
            enabled: true,
            logic: logic.to_string(),
            conditions,
            response: MockResponse {
                status,
                body: body.to_string(),
                headers: HashMap::new(),
                delay: None,
            },
        }
    }

    fn cond(field: &str, op: &str, value: Option<&str>) -> RuleCondition {
        RuleCondition {
            field: field.to_string(),
            op: op.to_string(),
            value: value.map(|v| v.to_string()),
            name: None,
            path: None,
        }
    }

    fn cond_with_name(field: &str, op: &str, name: &str, value: Option<&str>) -> RuleCondition {
        RuleCondition {
            field: field.to_string(),
            op: op.to_string(),
            value: value.map(|v| v.to_string()),
            name: Some(name.to_string()),
            path: None,
        }
    }

    fn cond_body_path(op: &str, path: &str, value: Option<&str>) -> RuleCondition {
        RuleCondition {
            field: "body_path".to_string(),
            op: op.to_string(),
            value: value.map(|v| v.to_string()),
            name: None,
            path: Some(path.to_string()),
        }
    }

    // ── Method matching ──────────────────────────────────────────────

    #[test]
    fn method_eq_matches() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(vec![cond("method", "eq", Some("POST"))], 201, "matched", "and")];
        let result = evaluate_rules(&rules, &ctx);
        assert!(result.is_some());
        assert_eq!(result.unwrap().status, 201);
    }

    #[test]
    fn method_eq_case_insensitive() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("post", "/", &headers, "", &query);

        let rules = vec![make_rule(vec![cond("method", "eq", Some("POST"))], 201, "matched", "and")];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn method_eq_no_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("GET", "/", &headers, "", &query);

        let rules = vec![make_rule(vec![cond("method", "eq", Some("POST"))], 201, "matched", "and")];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Path matching ────────────────────────────────────────────────

    #[test]
    fn path_eq() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/webhooks/stripe", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("path", "eq", Some("/webhooks/stripe"))],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn path_contains() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/webhooks/stripe/v1", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("path", "contains", Some("/stripe"))],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn path_starts_with() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/api/v2/hooks", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("path", "starts_with", Some("/api/v2"))],
            200, "v2", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn path_glob_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/webhooks/stripe/events", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("path", "matches", Some("/webhooks/*/events"))],
            200, "events", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn path_glob_double_star() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/api/v1/webhooks/stripe/events", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("path", "matches", Some("/api/**/events"))],
            200, "deep", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    // ── Header matching ──────────────────────────────────────────────

    #[test]
    fn header_exists() {
        let headers = HashMap::from([("stripe-signature".to_string(), "t=123,v1=abc".to_string())]);
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("header", "exists", "stripe-signature", None)],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn header_exists_missing() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("header", "exists", "stripe-signature", None)],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    #[test]
    fn header_eq() {
        let headers =
            HashMap::from([("content-type".to_string(), "application/json".to_string())]);
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name(
                "header",
                "eq",
                "Content-Type",
                Some("application/json"),
            )],
            200, "json", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn header_contains() {
        let headers = HashMap::from([(
            "user-agent".to_string(),
            "GitHub-Hookshot/abc123".to_string(),
        )]);
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("header", "contains", "user-agent", Some("GitHub"))],
            200, "github", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    // ── Body contains ────────────────────────────────────────────────

    #[test]
    fn body_contains_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"type": "invoice.paid", "amount": 100}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond("body_contains", "contains", Some("invoice.paid"))],
            200, "invoice", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_contains_no_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"type": "charge.succeeded"}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond("body_contains", "contains", Some("invoice.paid"))],
            200, "invoice", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Body JSON path ───────────────────────────────────────────────

    #[test]
    fn body_path_eq() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"type": "invoice.paid", "data": {"amount": 100}}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "type", Some("invoice.paid"))],
            200, "invoice", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_nested() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"data": {"object": {"status": "active"}}}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "data.object.status", Some("active"))],
            200, "active", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_array_index() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"items": [{"sku": "abc"}, {"sku": "def"}]}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "items.1.sku", Some("def"))],
            200, "second", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_exists() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"metadata": {"key": "value"}}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("exists", "metadata.key", None)],
            200, "exists", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_exists_missing() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"metadata": {}}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("exists", "metadata.key", None)],
            200, "exists", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    #[test]
    fn body_path_contains() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"message": "Hello World from Stripe"}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("contains", "message", Some("Stripe"))],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_numeric_value() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"amount": 1500}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "amount", Some("1500"))],
            200, "amount", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_boolean_value() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"paid": true}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "paid", Some("true"))],
            200, "paid", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn body_path_invalid_json() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = "not json";
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![make_rule(
            vec![cond_body_path("eq", "type", Some("test"))],
            200, "fail", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Query param matching ─────────────────────────────────────────

    #[test]
    fn query_exists() {
        let headers = HashMap::new();
        let query = HashMap::from([("source".to_string(), "test".to_string())]);
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("query", "exists", "source", None)],
            200, "has source", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn query_eq() {
        let headers = HashMap::new();
        let query = HashMap::from([("source".to_string(), "stripe".to_string())]);
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("query", "eq", "source", Some("stripe"))],
            200, "stripe source", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn query_eq_no_match() {
        let headers = HashMap::new();
        let query = HashMap::from([("source".to_string(), "github".to_string())]);
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name("query", "eq", "source", Some("stripe"))],
            200, "stripe", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Logic combinators ────────────────────────────────────────────

    #[test]
    fn and_logic_all_match() {
        let headers =
            HashMap::from([("content-type".to_string(), "application/json".to_string())]);
        let query = HashMap::new();
        let body = r#"{"type": "invoice.paid"}"#;
        let ctx = make_ctx("POST", "/webhooks", &headers, body, &query);

        let rules = vec![make_rule(
            vec![
                cond("method", "eq", Some("POST")),
                cond("path", "eq", Some("/webhooks")),
                cond_body_path("eq", "type", Some("invoice.paid")),
            ],
            201, "all match", "and",
        )];
        assert_eq!(evaluate_rules(&rules, &ctx).unwrap().status, 201);
    }

    #[test]
    fn and_logic_partial_match_fails() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let body = r#"{"type": "charge.succeeded"}"#;
        let ctx = make_ctx("POST", "/webhooks", &headers, body, &query);

        let rules = vec![make_rule(
            vec![
                cond("method", "eq", Some("POST")),
                cond_body_path("eq", "type", Some("invoice.paid")),
            ],
            201, "no match", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    #[test]
    fn or_logic_any_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("GET", "/health", &headers, "", &query);

        let rules = vec![make_rule(
            vec![
                cond("method", "eq", Some("POST")),
                cond("method", "eq", Some("GET")),
            ],
            200, "either", "or",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn or_logic_none_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("DELETE", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![
                cond("method", "eq", Some("POST")),
                cond("method", "eq", Some("GET")),
            ],
            200, "neither", "or",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Rule ordering & control ──────────────────────────────────────

    #[test]
    fn first_match_wins() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![
            make_rule(vec![cond("method", "eq", Some("POST"))], 201, "first", "and"),
            make_rule(vec![cond("method", "eq", Some("POST"))], 202, "second", "and"),
        ];
        assert_eq!(evaluate_rules(&rules, &ctx).unwrap().status, 201);
    }

    #[test]
    fn disabled_rules_skipped() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let mut rule1 = make_rule(vec![cond("method", "eq", Some("POST"))], 201, "disabled", "and");
        rule1.enabled = false;
        let rule2 = make_rule(vec![cond("method", "eq", Some("POST"))], 202, "enabled", "and");

        let rules = vec![rule1, rule2];
        assert_eq!(evaluate_rules(&rules, &ctx).unwrap().status, 202);
    }

    #[test]
    fn empty_rules_returns_none() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        assert!(evaluate_rules(&[], &ctx).is_none());
    }

    #[test]
    fn rule_with_empty_conditions_skipped() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![
            make_rule(vec![], 201, "empty conds", "and"),
            make_rule(vec![cond("method", "eq", Some("POST"))], 202, "real", "and"),
        ];
        assert_eq!(evaluate_rules(&rules, &ctx).unwrap().status, 202);
    }

    #[test]
    fn unknown_field_type_returns_false() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("unknown_field", "eq", Some("test"))],
            200, "nope", "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Glob pattern tests ───────────────────────────────────────────

    #[test]
    fn glob_single_star() {
        assert!(glob_match("/api/*/hook", "/api/v1/hook"));
        assert!(glob_match("/api/*/hook", "/api/v2/hook"));
        assert!(!glob_match("/api/*/hook", "/api/v1/v2/hook"));
    }

    #[test]
    fn glob_double_star() {
        assert!(glob_match("/api/**", "/api/v1/v2/hook"));
        assert!(glob_match("/api/**", "/api/test"));
        assert!(glob_match("/**", "/anything/goes/here"));
    }

    #[test]
    fn glob_literal() {
        assert!(glob_match("/exact/path", "/exact/path"));
        assert!(!glob_match("/exact/path", "/exact/other"));
    }

    #[test]
    fn glob_question_mark() {
        assert!(glob_match("/api/v?/hook", "/api/v1/hook"));
        assert!(glob_match("/api/v?/hook", "/api/v2/hook"));
        assert!(!glob_match("/api/v?/hook", "/api/v10/hook"));
    }

    // ── JSON path edge cases ─────────────────────────────────────────

    #[test]
    fn walk_json_path_root() {
        let val: serde_json::Value = serde_json::json!({"key": "value"});
        let result = walk_json_path(&val, "key");
        assert_eq!(result, Some(&serde_json::json!("value")));
    }

    #[test]
    fn walk_json_path_deeply_nested() {
        let val: serde_json::Value = serde_json::json!({"a": {"b": {"c": {"d": "found"}}}});
        let result = walk_json_path(&val, "a.b.c.d");
        assert_eq!(result, Some(&serde_json::json!("found")));
    }

    #[test]
    fn walk_json_path_missing_key() {
        let val: serde_json::Value = serde_json::json!({"a": {"b": 1}});
        assert!(walk_json_path(&val, "a.c").is_none());
    }

    #[test]
    fn walk_json_path_through_non_object() {
        let val: serde_json::Value = serde_json::json!({"a": "string"});
        assert!(walk_json_path(&val, "a.b").is_none());
    }

    // ── Integration-style tests ──────────────────────────────────────

    #[test]
    fn realistic_stripe_routing() {
        let headers = HashMap::from([
            ("stripe-signature".to_string(), "t=123,v1=abc".to_string()),
            ("content-type".to_string(), "application/json".to_string()),
        ]);
        let query = HashMap::new();
        let body = r#"{"type": "invoice.payment_succeeded", "data": {"object": {"id": "in_123"}}}"#;
        let ctx = make_ctx("POST", "/", &headers, body, &query);

        let rules = vec![
            make_rule(
                vec![
                    cond_with_name("header", "exists", "stripe-signature", None),
                    cond_body_path("eq", "type", Some("checkout.session.completed")),
                ],
                200,
                r#"{"received": true, "event": "checkout"}"#,
                "and",
            ),
            make_rule(
                vec![
                    cond_with_name("header", "exists", "stripe-signature", None),
                    cond_body_path("eq", "type", Some("invoice.payment_succeeded")),
                ],
                200,
                r#"{"received": true, "event": "invoice"}"#,
                "and",
            ),
            make_rule(
                vec![cond_with_name("header", "exists", "x-github-event", None)],
                200,
                r#"{"received": true, "source": "github"}"#,
                "and",
            ),
        ];

        let result = evaluate_rules(&rules, &ctx).unwrap();
        assert_eq!(result.status, 200);
        assert!(result.body.contains("invoice"));
    }

    #[test]
    fn fallthrough_to_none_when_no_match() {
        let headers = HashMap::from([("x-custom".to_string(), "hello".to_string())]);
        let query = HashMap::new();
        let body = r#"{"event": "unknown"}"#;
        let ctx = make_ctx("PUT", "/other", &headers, body, &query);

        let rules = vec![
            make_rule(vec![cond("method", "eq", Some("POST"))], 200, "post only", "and"),
            make_rule(
                vec![cond_with_name("header", "exists", "stripe-signature", None)],
                200, "stripe", "and",
            ),
        ];

        assert!(evaluate_rules(&rules, &ctx).is_none());
    }
}
