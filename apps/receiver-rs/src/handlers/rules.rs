//! Conditional response rule evaluation engine.
//!
//! Evaluates an ordered list of rules against an incoming request. First
//! matching rule wins. Returns `None` if no rules match (caller falls back to
//! the default mock_response or 200 OK).
//!
//! The condition language is shared with forwarding filters, which the web
//! app evaluates with the SDK (`packages/sdk/src/rules.ts`). Both run the
//! vectors in `packages/sdk/conformance/rules.json`; change them together.
//! Response rules read the HTTP request only: fields that need the email or
//! the signature check (kind, email, email_field, spam_score, email_auth,
//! signature) never hold here.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

use super::values::{self, LazyBody};
use super::webhook::MockResponse;

/// A single condition within a response rule.
#[derive(Debug, Deserialize, Clone)]
pub struct RuleCondition {
    /// Field to match against: method, path, header, query, body,
    /// body_contains, body_path, content_type, size
    pub field: String,
    /// Operator: eq, neq, contains, not_contains, starts_with, ends_with,
    /// matches, regex, exists, not_exists, gt, gte, lt, lte
    pub op: String,
    /// Value to compare against (not required for exists and not_exists)
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
    pub content_type: Option<&'a str>,
    pub size: Option<u64>,
}

/// Evaluate rules in order. Returns the response from the first matching rule,
/// or `None` if no rules match.
#[cfg(test)]
pub fn evaluate_rules(rules: &[ResponseRule], ctx: &RequestContext<'_>) -> Option<MockResponse> {
    let body = LazyBody::new(ctx.body, ctx.content_type);
    evaluate_rules_with(rules, ctx, &body)
}

/// `evaluate_rules` with a body the caller parses at most once (the
/// placeholders of the chosen response read it too).
pub(crate) fn evaluate_rules_with(
    rules: &[ResponseRule],
    ctx: &RequestContext<'_>,
    body: &LazyBody<'_>,
) -> Option<MockResponse> {
    for rule in rules {
        if !rule.enabled || rule.conditions.is_empty() {
            continue;
        }
        if conditions_hold(&rule.logic, &rule.conditions, ctx, body) {
            return Some(rule.response.clone());
        }
    }
    None
}

/// Whether the conditions hold together: every one ("and") or any ("or").
/// No conditions hold.
pub(crate) fn conditions_hold(
    logic: &str,
    conditions: &[RuleCondition],
    ctx: &RequestContext<'_>,
    body: &LazyBody<'_>,
) -> bool {
    if conditions.is_empty() {
        return true;
    }
    if logic == "or" {
        conditions.iter().any(|c| evaluate_condition(c, ctx, body))
    } else {
        conditions.iter().all(|c| evaluate_condition(c, ctx, body))
    }
}

/// What a condition reads: a value, or nothing when it is absent.
enum Resolved<'v> {
    Text(String),
    Json(&'v Value),
    Number(u64),
    Absent,
}

const STRING_OPS: &[&str] = &[
    "eq",
    "neq",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "matches",
    "regex",
];
const PRESENCE_OPS: &[&str] = &["exists", "not_exists"];
const NUMBER_OPS: &[&str] = &["gt", "gte", "lt", "lte"];

/// Whether `field` takes `op` (the SDK's CONDITION_FIELDS, response fields only).
fn op_allowed(field: &str, op: &str) -> bool {
    let any = |lists: &[&[&str]]| lists.iter().any(|list| list.contains(&op));
    match field {
        "method" => matches!(op, "eq" | "neq"),
        "path" => STRING_OPS.contains(&op),
        "header" | "query" | "body_path" => any(&[PRESENCE_OPS, STRING_OPS, NUMBER_OPS]),
        "body" => matches!(op, "contains" | "not_contains" | "regex"),
        "body_contains" => op == "contains",
        "content_type" => matches!(
            op,
            "eq" | "neq" | "contains" | "not_contains" | "starts_with" | "regex"
        ),
        "size" => matches!(op, "eq" | "neq") || NUMBER_OPS.contains(&op),
        _ => false,
    }
}

fn resolve<'v>(
    condition: &RuleCondition,
    ctx: &RequestContext<'_>,
    body: &'v LazyBody<'_>,
) -> Resolved<'v> {
    let text = |s: &str| Resolved::Text(s.to_string());
    match condition.field.as_str() {
        "method" => text(ctx.method),
        "path" => text(ctx.path),
        "header" => {
            let Some(name) = condition.name.as_deref() else {
                return Resolved::Absent;
            };
            let name = name.to_lowercase();
            ctx.headers
                .iter()
                .find(|(key, _)| key.to_lowercase() == name)
                .map_or(Resolved::Absent, |(_, value)| text(value))
        }
        "query" => condition
            .name
            .as_deref()
            .and_then(|name| ctx.query.get(name))
            .map_or(Resolved::Absent, |value| text(value)),
        "body" | "body_contains" => text(ctx.body),
        "body_path" => {
            let Some(keys) = condition
                .path
                .as_deref()
                .and_then(|path| values::parse_path(path, false))
            else {
                return Resolved::Absent;
            };
            body.get()
                .and_then(|root| values::walk(root, &keys))
                .map_or(Resolved::Absent, Resolved::Json)
        }
        "content_type" => ctx.content_type.map_or(Resolved::Absent, text),
        "size" => ctx.size.map_or(Resolved::Absent, Resolved::Number),
        _ => Resolved::Absent,
    }
}

fn to_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // JavaScript's Number(): decimal and exponent forms (hex and the like
    // never come up in rule values, which validation keeps to numbers).
    let n: f64 = trimmed.parse().ok()?;
    n.is_finite().then_some(n)
}

/// A positive comparison against one present value.
fn compare(op: &str, field: &str, actual: &Resolved<'_>, expected: &str) -> bool {
    let (comparable, number) = match actual {
        Resolved::Text(s) => (s.clone(), to_number(s)),
        Resolved::Json(value) => {
            let number = match value {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => to_number(s),
                _ => None,
            };
            (values::comparable(value), number)
        }
        Resolved::Number(n) => (n.to_string(), Some(*n as f64)),
        Resolved::Absent => return false,
    };
    let caseless = matches!(field, "method" | "content_type");
    let (text, target) = if caseless {
        (comparable.to_lowercase(), expected.to_lowercase())
    } else {
        (comparable.clone(), expected.to_string())
    };
    match op {
        "eq" => text == target,
        "contains" => text.contains(&target),
        "starts_with" => text.starts_with(&target),
        "ends_with" => text.ends_with(&target),
        "matches" => values::glob_match(expected, &comparable),
        "regex" => values::regex_search(expected, &comparable),
        "gt" | "gte" | "lt" | "lte" => {
            let (Some(a), Some(b)) = (number, to_number(expected)) else {
                return false;
            };
            match op {
                "gt" => a > b,
                "gte" => a >= b,
                "lt" => a < b,
                _ => a <= b,
            }
        }
        _ => false,
    }
}

/// Evaluate a single condition against the request context. Unknown fields
/// and operators a field does not take never hold.
fn evaluate_condition(
    condition: &RuleCondition,
    ctx: &RequestContext<'_>,
    body: &LazyBody<'_>,
) -> bool {
    let field = condition.field.as_str();
    let op = condition.op.as_str();
    if !op_allowed(field, op) {
        return false;
    }
    let resolved = resolve(condition, ctx, body);
    if op == "exists" || op == "not_exists" {
        let present = !matches!(resolved, Resolved::Absent);
        return (op == "exists") == present;
    }
    let Some(expected) = condition.value.as_deref() else {
        return false;
    };
    let (positive, negate) = match op {
        "neq" => ("eq", true),
        "not_contains" => ("contains", true),
        other => (other, false),
    };
    compare(positive, field, &resolved, expected) != negate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::values::glob_match;

    fn walk_json_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
        values::walk(root, &values::parse_path(path, false)?)
    }

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
            content_type: None,
            size: None,
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

        let rules = vec![make_rule(
            vec![cond("method", "eq", Some("POST"))],
            201,
            "matched",
            "and",
        )];
        let result = evaluate_rules(&rules, &ctx);
        assert!(result.is_some());
        assert_eq!(result.unwrap().status, 201);
    }

    #[test]
    fn method_eq_case_insensitive() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("post", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("method", "eq", Some("POST"))],
            201,
            "matched",
            "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn method_eq_no_match() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("GET", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond("method", "eq", Some("POST"))],
            201,
            "matched",
            "and",
        )];
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
            200,
            "stripe",
            "and",
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
            200,
            "stripe",
            "and",
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
            200,
            "v2",
            "and",
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
            200,
            "events",
            "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_some());
    }

    #[test]
    fn path_glob_double_star() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx(
            "POST",
            "/api/v1/webhooks/stripe/events",
            &headers,
            "",
            &query,
        );

        let rules = vec![make_rule(
            vec![cond("path", "matches", Some("/api/**/events"))],
            200,
            "deep",
            "and",
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
            200,
            "stripe",
            "and",
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
            200,
            "stripe",
            "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    #[test]
    fn header_eq() {
        let headers = HashMap::from([("content-type".to_string(), "application/json".to_string())]);
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let rules = vec![make_rule(
            vec![cond_with_name(
                "header",
                "eq",
                "Content-Type",
                Some("application/json"),
            )],
            200,
            "json",
            "and",
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
            vec![cond_with_name(
                "header",
                "contains",
                "user-agent",
                Some("GitHub"),
            )],
            200,
            "github",
            "and",
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
            200,
            "invoice",
            "and",
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
            200,
            "invoice",
            "and",
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
            200,
            "invoice",
            "and",
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
            200,
            "active",
            "and",
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
            200,
            "second",
            "and",
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
            200,
            "exists",
            "and",
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
            200,
            "exists",
            "and",
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
            200,
            "stripe",
            "and",
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
            200,
            "amount",
            "and",
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
            200,
            "paid",
            "and",
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
            200,
            "fail",
            "and",
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
            200,
            "has source",
            "and",
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
            200,
            "stripe source",
            "and",
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
            200,
            "stripe",
            "and",
        )];
        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Logic combinators ────────────────────────────────────────────

    #[test]
    fn and_logic_all_match() {
        let headers = HashMap::from([("content-type".to_string(), "application/json".to_string())]);
        let query = HashMap::new();
        let body = r#"{"type": "invoice.paid"}"#;
        let ctx = make_ctx("POST", "/webhooks", &headers, body, &query);

        let rules = vec![make_rule(
            vec![
                cond("method", "eq", Some("POST")),
                cond("path", "eq", Some("/webhooks")),
                cond_body_path("eq", "type", Some("invoice.paid")),
            ],
            201,
            "all match",
            "and",
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
            201,
            "no match",
            "and",
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
            200,
            "either",
            "or",
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
            200,
            "neither",
            "or",
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
            make_rule(
                vec![cond("method", "eq", Some("POST"))],
                201,
                "first",
                "and",
            ),
            make_rule(
                vec![cond("method", "eq", Some("POST"))],
                202,
                "second",
                "and",
            ),
        ];
        assert_eq!(evaluate_rules(&rules, &ctx).unwrap().status, 201);
    }

    #[test]
    fn disabled_rules_skipped() {
        let headers = HashMap::new();
        let query = HashMap::new();
        let ctx = make_ctx("POST", "/", &headers, "", &query);

        let mut rule1 = make_rule(
            vec![cond("method", "eq", Some("POST"))],
            201,
            "disabled",
            "and",
        );
        rule1.enabled = false;
        let rule2 = make_rule(
            vec![cond("method", "eq", Some("POST"))],
            202,
            "enabled",
            "and",
        );

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
            200,
            "nope",
            "and",
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
            make_rule(
                vec![cond("method", "eq", Some("POST"))],
                200,
                "post only",
                "and",
            ),
            make_rule(
                vec![cond_with_name("header", "exists", "stripe-signature", None)],
                200,
                "stripe",
                "and",
            ),
        ];

        assert!(evaluate_rules(&rules, &ctx).is_none());
    }

    // ── Shared vectors (packages/sdk/conformance/rules.json) ─────────

    #[derive(Deserialize)]
    struct VectorRequest {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        query: HashMap<String, String>,
        body: String,
        #[serde(rename = "contentType")]
        content_type: Option<String>,
        size: u64,
    }

    #[derive(Deserialize)]
    struct VectorGroup {
        #[serde(default = "default_and")]
        logic: String,
        conditions: Vec<RuleCondition>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        request: String,
        group: VectorGroup,
        expected: bool,
    }

    #[derive(Deserialize)]
    struct Vectors {
        requests: HashMap<String, VectorRequest>,
        vectors: Vec<Vector>,
    }

    #[test]
    fn shared_vectors() {
        let file: Vectors = serde_json::from_str(include_str!(
            "../../../../packages/sdk/conformance/rules.json"
        ))
        .unwrap();
        assert!(file.vectors.len() > 50);
        for vector in &file.vectors {
            let request = &file.requests[&vector.request];
            let ctx = RequestContext {
                method: &request.method,
                path: &request.path,
                headers: &request.headers,
                body: &request.body,
                query: &request.query,
                content_type: request.content_type.as_deref(),
                size: Some(request.size),
            };
            let body = LazyBody::new(ctx.body, ctx.content_type);
            assert_eq!(
                conditions_hold(&vector.group.logic, &vector.group.conditions, &ctx, &body),
                vector.expected,
                "{}",
                vector.name
            );
        }
    }
}
