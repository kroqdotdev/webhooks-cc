//! Placeholders in mock responses: `{{ json.id }}`, `{{ headers.user-agent |
//! lower }}`, `{{ uuid }}`, filled in from the request that is being
//! answered.
//!
//! A port of the SDK's `packages/sdk/src/placeholders.ts`, which fills in
//! forwarded payloads and the dashboard's preview. Both run the vectors in
//! `packages/sdk/conformance/placeholders.json`; change them together.
//!
//! There are no loops or conditions (rules choose the response), so filling
//! in always finishes, and the output stops at a byte limit. A placeholder
//! whose first key is not part of the context (`{{ name }}` in a body
//! written for another template engine) stays as written, so bodies saved
//! before placeholders existed are sent unchanged.

use serde_json::{Map, Value};
use std::collections::HashMap;

use super::values::{self, LazyBody};

/// Keys of the context; anything else stays as written.
const ROOTS: &[&str] = &[
    "id",
    "kind",
    "method",
    "path",
    "query",
    "headers",
    "body",
    "json",
    "contentType",
    "ip",
    "size",
    "receivedAt",
    "endpoint",
    "uuid",
    "now",
];

/// How filled-in values are written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// As they are.
    Text,
    /// Inside a JSON body: strings escaped (the template has the quotes),
    /// other values as JSON.
    Json,
    /// HTML-escaped.
    Html,
}

#[derive(Debug, Clone, PartialEq)]
enum Filter {
    Default(String),
    Json,
    Lower,
    Upper,
    Truncate(usize),
}

#[derive(Debug, Clone, PartialEq)]
struct Placeholder {
    keys: Vec<String>,
    filters: Vec<Filter>,
}

enum Part<'s> {
    Text(&'s str),
    Placeholder(Placeholder, &'s str),
}

/// The request a response answers, as placeholders read it.
pub(crate) struct TemplateRequest<'a> {
    pub id: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    /// Header names in lowercase.
    pub headers: &'a HashMap<String, String>,
    pub query: &'a HashMap<String, String>,
    pub body: &'a LazyBody<'a>,
    pub body_text: &'a str,
    pub content_type: Option<&'a str>,
    pub ip: &'a str,
    pub size: u64,
    /// RFC 3339, UTC, milliseconds.
    pub received_at: &'a str,
    pub endpoint_slug: &'a str,
    pub endpoint_name: Option<&'a str>,
    /// One per response.
    pub uuid: &'a str,
    /// RFC 3339, UTC, milliseconds.
    pub now: &'a str,
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// Parses what is between `{{` and `}}`; `None` when it is not a placeholder.
fn parse_placeholder(inner: &str) -> Option<Placeholder> {
    let bytes = inner.as_bytes();
    let mut i = 0;
    let skip_space = |i: &mut usize| {
        while *i < bytes.len() && is_space(bytes[*i]) {
            *i += 1;
        }
    };
    skip_space(&mut i);
    let path_start = i;
    let mut in_bracket = false;
    let mut in_string = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                i += 1;
            } else if b == b'"' {
                in_string = false;
            }
        } else if in_bracket {
            if b == b'"' {
                in_string = true;
            } else if b == b']' {
                in_bracket = false;
            }
        } else if b == b'[' {
            in_bracket = true;
        } else if is_space(b) || b == b'|' {
            break;
        }
        i += 1;
    }
    let i_path_end = i.min(bytes.len());
    let path_text = inner.get(path_start..i_path_end)?;
    if path_text.is_empty() || path_text.starts_with('.') || path_text.starts_with('[') {
        return None;
    }
    let keys = values::parse_path(path_text, true)?;
    if keys.is_empty() {
        return None;
    }
    let mut i = i_path_end;

    let mut filters = Vec::new();
    skip_space(&mut i);
    while i < bytes.len() {
        if bytes[i] != b'|' {
            return None;
        }
        i += 1;
        skip_space(&mut i);
        let name_start = i;
        while i < bytes.len() && bytes[i].is_ascii_lowercase() {
            i += 1;
        }
        let name = &inner[name_start..i];
        if !matches!(name, "default" | "json" | "lower" | "upper" | "truncate") {
            return None;
        }
        skip_space(&mut i);
        enum Arg {
            Text(String),
            Digits(String),
        }
        let mut arg = None;
        if bytes.get(i) == Some(&b':') {
            i += 1;
            skip_space(&mut i);
            if bytes.get(i) == Some(&b'"') {
                i += 1;
                let mut text = String::new();
                let mut closed = false;
                let rest = &inner[i..];
                let mut chars = rest.char_indices();
                while let Some((offset, ch)) = chars.next() {
                    if ch == '\\' {
                        match chars.next() {
                            Some((_, next @ ('"' | '\\'))) => text.push(next),
                            _ => return None,
                        }
                        continue;
                    }
                    if ch == '"' {
                        closed = true;
                        i += offset + 1;
                        break;
                    }
                    text.push(ch);
                }
                if !closed {
                    return None;
                }
                arg = Some(Arg::Text(text));
            } else {
                let digits_start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i == digits_start {
                    return None;
                }
                arg = Some(Arg::Digits(inner[digits_start..i].to_string()));
            }
            skip_space(&mut i);
        }
        let filter = match (name, arg) {
            ("default", Some(Arg::Text(text))) => Filter::Default(text),
            ("default", Some(Arg::Digits(digits))) => {
                // JavaScript reads the digits as a number and writes it back.
                let n: f64 = digits.parse().ok()?;
                Filter::Default(values::format_number(&serde_json::Number::from_f64(n)?))
            }
            ("truncate", Some(Arg::Digits(digits))) => {
                let n: usize = digits.parse().ok()?;
                if !(1..=1_000_000).contains(&n) {
                    return None;
                }
                Filter::Truncate(n)
            }
            ("json", None) => Filter::Json,
            ("lower", None) => Filter::Lower,
            ("upper", None) => Filter::Upper,
            _ => return None,
        };
        filters.push(filter);
    }
    Some(Placeholder { keys, filters })
}

/// Splits a template into text and placeholders. A `{{` that does not open a
/// valid placeholder is text, and scanning goes on at the next character.
fn parse_template(source: &str) -> Vec<Part<'_>> {
    let mut parts = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    while i < source.len() {
        let Some(open_rel) = source[i..].find("{{") else {
            break;
        };
        let open = i + open_rel;
        let close = source[open + 2..].find("}}").map(|rel| open + 2 + rel);
        let placeholder = close.and_then(|close| parse_placeholder(&source[open + 2..close]));
        match (placeholder, close) {
            (Some(placeholder), Some(close)) => {
                if open > text_start {
                    parts.push(Part::Text(&source[text_start..open]));
                }
                parts.push(Part::Placeholder(placeholder, &source[open..close + 2]));
                i = close + 2;
                text_start = i;
            }
            _ => {
                i = open + 1;
            }
        }
    }
    if text_start < source.len() {
        parts.push(Part::Text(&source[text_start..]));
    }
    parts
}

fn string_map(map: &HashMap<String, String>) -> Value {
    let mut entries: Vec<_> = map.iter().collect();
    entries.sort();
    Value::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect::<Map<_, _>>(),
    )
}

/// The value a placeholder's keys lead to, or `None` when it leads nowhere.
fn lookup(request: &TemplateRequest<'_>, keys: &[String]) -> Option<Value> {
    let (root, rest) = keys.split_first()?;
    let whole = match root.as_str() {
        "id" => Value::String(request.id.to_string()),
        "kind" => Value::String("http".to_string()),
        "method" => Value::String(request.method.to_string()),
        "path" => Value::String(request.path.to_string()),
        "query" => {
            if let Some(name) = rest.first() {
                let value = request.query.get(name.as_str())?;
                return values::walk(&Value::String(value.clone()), &rest[1..]).cloned();
            }
            string_map(request.query)
        }
        "headers" => {
            if let Some(name) = rest.first() {
                let value = request.headers.get(&name.to_lowercase())?;
                return values::walk(&Value::String(value.clone()), &rest[1..]).cloned();
            }
            string_map(request.headers)
        }
        "body" => Value::String(request.body_text.to_string()),
        "json" => return request.body.get().and_then(|root| values::walk(root, rest)).cloned(),
        "contentType" => request
            .content_type
            .map_or(Value::Null, |ct| Value::String(ct.to_string())),
        "ip" => Value::String(request.ip.to_string()),
        "size" => Value::Number(request.size.into()),
        "receivedAt" => Value::String(request.received_at.to_string()),
        "endpoint" => serde_json::json!({
            "slug": request.endpoint_slug,
            "name": request.endpoint_name,
        }),
        "uuid" => Value::String(request.uuid.to_string()),
        "now" => Value::String(request.now.to_string()),
        _ => return None,
    };
    values::walk(&whole, rest).cloned()
}

/// A value after filters; `raw` when the last filter was json.
struct Filled {
    value: Option<Value>,
    raw: bool,
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

fn text_of(value: &Option<Value>) -> String {
    value.as_ref().map(values::value_to_text).unwrap_or_default()
}

fn fill(placeholder: &Placeholder, request: &TemplateRequest<'_>) -> Filled {
    let mut value = lookup(request, &placeholder.keys);
    let mut raw = false;
    for filter in &placeholder.filters {
        raw = false;
        value = match filter {
            Filter::Default(text) => match &value {
                None | Some(Value::Null) => Some(Value::String(text.clone())),
                Some(Value::String(s)) if s.is_empty() => Some(Value::String(text.clone())),
                _ => value,
            },
            Filter::Json => {
                raw = true;
                Some(Value::String(values::to_json(
                    value.as_ref().unwrap_or(&Value::Null),
                )))
            }
            Filter::Lower => Some(Value::String(text_of(&value).to_lowercase())),
            Filter::Upper => Some(Value::String(text_of(&value).to_uppercase())),
            Filter::Truncate(max) => Some(Value::String(truncate(&text_of(&value), *max))),
        };
    }
    Filled { value, raw }
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

fn write(filled: &Filled, mode: Mode) -> String {
    if filled.raw {
        let text = text_of(&filled.value);
        return if mode == Mode::Html {
            html_escape(&text)
        } else {
            text
        };
    }
    match mode {
        Mode::Json => match &filled.value {
            None => String::new(),
            Some(Value::String(s)) => {
                let quoted = values::json_string(s);
                quoted[1..quoted.len() - 1].to_string()
            }
            Some(other) => values::to_json(other),
        },
        Mode::Text => text_of(&filled.value),
        Mode::Html => html_escape(&text_of(&filled.value)),
    }
}

/// Appends pieces until the output would pass `max_bytes`, cutting at a
/// character.
struct Output {
    text: String,
    max_bytes: usize,
    full: bool,
}

impl Output {
    fn push(&mut self, piece: &str) {
        if self.full || piece.is_empty() {
            return;
        }
        if self.text.len() + piece.len() <= self.max_bytes {
            self.text.push_str(piece);
            return;
        }
        for ch in piece.chars() {
            if self.text.len() + ch.len_utf8() > self.max_bytes {
                break;
            }
            self.text.push(ch);
        }
        self.full = true;
    }
}

/// Whether a string holds anything that could be a placeholder.
pub(crate) fn may_have_placeholders(source: &str) -> bool {
    source.contains("{{")
}

/// Fills in a template, stopping once the output reaches `max_bytes`.
pub(crate) fn render(
    source: &str,
    request: &TemplateRequest<'_>,
    mode: Mode,
    max_bytes: usize,
) -> String {
    if !may_have_placeholders(source) {
        return source.to_string();
    }
    let mut out = Output {
        text: String::new(),
        max_bytes,
        full: false,
    };
    for part in parse_template(source) {
        match part {
            Part::Text(text) => out.push(text),
            Part::Placeholder(placeholder, written) => {
                if ROOTS.contains(&placeholder.keys[0].as_str()) {
                    out.push(&write(&fill(&placeholder, request), mode));
                } else {
                    out.push(written);
                }
            }
        }
        if out.full {
            break;
        }
    }
    out.text
}

/// The mode for a mock response body: json when the Content-Type says JSON
/// (or, without one, when the body starts with `{` or `[`), html for HTML
/// and XML, text otherwise.
pub(crate) fn response_mode(body: &str, headers: &HashMap<String, String>) -> Mode {
    let content_type = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.to_lowercase())
        .last();
    if let Some(content_type) = content_type {
        if content_type.contains("json") {
            return Mode::Json;
        }
        if content_type.contains("html") || content_type.contains("xml") {
            return Mode::Html;
        }
        return Mode::Text;
    }
    match body.trim_start().chars().next() {
        Some('{' | '[') => Mode::Json,
        _ => Mode::Text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

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
    struct Vector {
        name: String,
        request: String,
        template: String,
        mode: String,
        #[serde(rename = "maxBytes")]
        max_bytes: Option<usize>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct ModeVector {
        name: String,
        body: String,
        headers: HashMap<String, String>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Vectors {
        requests: HashMap<String, VectorRequest>,
        vectors: Vec<Vector>,
        modes: Vec<ModeVector>,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!(
            "../../../../packages/sdk/conformance/placeholders.json"
        ))
        .unwrap()
    }

    fn mode_of(name: &str) -> Mode {
        match name {
            "json" => Mode::Json,
            "html" => Mode::Html,
            _ => Mode::Text,
        }
    }

    #[test]
    fn shared_vectors() {
        let file = vectors();
        assert!(file.vectors.len() > 40);
        for vector in &file.vectors {
            let request = &file.requests[&vector.request];
            let id = format!("req_{}", vector.request);
            let body = LazyBody::new(&request.body, request.content_type.as_deref());
            let template_request = TemplateRequest {
                id: &id,
                method: &request.method,
                path: &request.path,
                headers: &request.headers,
                query: &request.query,
                body: &body,
                body_text: &request.body,
                content_type: request.content_type.as_deref(),
                ip: "203.0.113.7",
                size: request.size,
                received_at: "2026-01-01T00:00:00.123Z",
                endpoint_slug: "acme-orders",
                endpoint_name: (vector.request != "empty").then_some("Acme orders"),
                uuid: "00000000-0000-4000-8000-000000000000",
                now: "2026-01-01T00:00:00.000Z",
            };
            let out = render(
                &vector.template,
                &template_request,
                mode_of(&vector.mode),
                vector.max_bytes.unwrap_or(usize::MAX),
            );
            assert_eq!(out, vector.expected, "{}", vector.name);
        }
    }

    #[test]
    fn shared_mode_vectors() {
        for vector in vectors().modes {
            assert_eq!(
                response_mode(&vector.body, &vector.headers),
                mode_of(&vector.expected),
                "{}",
                vector.name
            );
        }
    }
}
