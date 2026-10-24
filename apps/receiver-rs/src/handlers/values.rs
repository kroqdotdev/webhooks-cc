//! What response rules and placeholders share: dot paths into the body, the
//! body read as JSON or form fields, values written as text the way
//! JavaScript writes them, and a cache of compiled regular expressions.
//!
//! The SDK's `rules.ts` is the reference (the forwarding worker and the
//! dashboard use it); the vectors in `packages/sdk/conformance/rules.json`
//! and `placeholders.json` pin both.

use regex::{Regex, RegexBuilder};
use serde_json::{Map, Number, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// Longest glob or regular expression a rule may use.
pub(crate) const MAX_PATTERN_CHARS: usize = 500;

/// Compiled patterns kept per worker thread; the cache empties when full.
const REGEX_CACHE_SIZE: usize = 256;

/// Splits a dot path into keys: `data.items.0.id`, with `["odd.key"]` for a
/// key holding a dot and `[0]` for an index. Empty segments are skipped.
/// `None` when a bracket is malformed or, with `strict` (placeholders), a
/// character outside letters, digits, `_`, `-`, `$` and `@` appears outside
/// brackets.
pub(crate) fn parse_path(path: &str, strict: bool) -> Option<Vec<String>> {
    let chars: Vec<char> = path.chars().collect();
    let mut keys = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '.' {
            if !current.is_empty() {
                keys.push(std::mem::take(&mut current));
            }
            i += 1;
            continue;
        }
        if ch == '[' {
            if !current.is_empty() {
                keys.push(std::mem::take(&mut current));
            }
            let (key, next) = read_bracket(&chars, i)?;
            keys.push(key);
            i = next;
            continue;
        }
        if strict && !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '$' | '@')) {
            return None;
        }
        current.push(ch);
        i += 1;
    }
    if !current.is_empty() {
        keys.push(current);
    }
    Some(keys)
}

/// `["key"]` (with `\"` and `\\` escapes) or `[123]` starting at `start`.
fn read_bracket(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut i = start + 1;
    if chars.get(i) == Some(&'"') {
        i += 1;
        let mut key = String::new();
        while i < chars.len() {
            let ch = chars[i];
            if ch == '\\' {
                let next = *chars.get(i + 1)?;
                if next != '"' && next != '\\' {
                    return None;
                }
                key.push(next);
                i += 2;
                continue;
            }
            if ch == '"' {
                if chars.get(i + 1) != Some(&']') {
                    return None;
                }
                return Some((key, i + 2));
            }
            key.push(ch);
            i += 1;
        }
        return None;
    }
    let mut digits = String::new();
    while i < chars.len() && chars[i].is_ascii_digit() {
        digits.push(chars[i]);
        i += 1;
    }
    if digits.is_empty() || chars.get(i) != Some(&']') {
        return None;
    }
    Some((digits, i + 1))
}

/// The value at `keys`, or `None`. A key indexes an array only when it is
/// all digits.
pub(crate) fn walk<'a>(root: &'a Value, keys: &[String]) -> Option<&'a Value> {
    let mut current = root;
    for key in keys {
        current = match current {
            Value::Object(map) => map.get(key.as_str())?,
            Value::Array(items) => {
                if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                items.get(key.parse::<usize>().ok()?)?
            }
            _ => return None,
        };
    }
    Some(current)
}

/// The body as structured data: parsed JSON when it is JSON, form fields
/// when the content type is `application/x-www-form-urlencoded` (a repeated
/// name keeps its last value), otherwise `None`.
pub(crate) fn structured_body(body: &str, content_type: Option<&str>) -> Option<Value> {
    if body.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Some(value);
    }
    let is_form = content_type.is_some_and(|ct| {
        ct.to_ascii_lowercase()
            .contains("application/x-www-form-urlencoded")
    });
    if !is_form {
        return None;
    }
    let mut fields = Map::new();
    for (name, value) in url::form_urlencoded::parse(body.as_bytes()) {
        fields.insert(name.into_owned(), Value::String(value.into_owned()));
    }
    Some(Value::Object(fields))
}

/// The body parsed at most once per request, shared by the rules and the
/// placeholders.
pub(crate) struct LazyBody<'a> {
    body: &'a str,
    content_type: Option<&'a str>,
    parsed: std::cell::OnceCell<Option<Value>>,
}

impl<'a> LazyBody<'a> {
    pub(crate) fn new(body: &'a str, content_type: Option<&'a str>) -> Self {
        Self {
            body,
            content_type,
            parsed: std::cell::OnceCell::new(),
        }
    }

    pub(crate) fn get(&self) -> Option<&Value> {
        self.parsed
            .get_or_init(|| structured_body(self.body, self.content_type))
            .as_ref()
    }
}

/// A number as JavaScript's `String(n)` writes it: integers without `.0`,
/// exponents from 1e21 up and below 1e-6, with a sign on positive exponents.
pub(crate) fn format_number(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let Some(f) = n.as_f64() else {
        return n.to_string();
    };
    format_f64(f)
}

fn format_f64(f: f64) -> String {
    if f == 0.0 {
        return "0".to_string();
    }
    if !f.is_finite() {
        return "null".to_string();
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        if f.fract() == 0.0 {
            return format!("{f:.0}");
        }
        return format!("{f}");
    }
    // Shortest digits in exponent form, as JavaScript writes them (1e+22, 1.5e-7).
    let text = format!("{f:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// Compact JSON with keys in their own order and numbers written as
/// JavaScript writes them (what `JSON.stringify` gives).
pub(crate) fn to_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&format_number(n)),
        Value::String(s) => out.push_str(&json_string(s)),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&json_string(key));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// A string as a JSON string literal, quotes included.
pub(crate) fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// A value as text: strings as they are, numbers as JavaScript writes them,
/// objects and arrays as compact JSON; null is empty.
pub(crate) fn value_to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => format_number(n),
        Value::Bool(b) => b.to_string(),
        other => to_json(other),
    }
}

/// What `eq` and friends compare: like `value_to_text`, but null reads "null".
pub(crate) fn comparable(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        other => value_to_text(other),
    }
}

thread_local! {
    static REGEX_CACHE: RefCell<HashMap<String, Option<Arc<Regex>>>> = RefCell::new(HashMap::new());
}

/// The compiled pattern, or `None` when it is too long or does not compile.
/// Compiled once per worker thread; the `regex` crate runs in time linear in
/// the input, so a pattern cannot stall the receiver.
pub(crate) fn compiled(pattern: &str) -> Option<Arc<Regex>> {
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return None;
    }
    REGEX_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(found) = cache.get(pattern) {
            return found.clone();
        }
        if cache.len() >= REGEX_CACHE_SIZE {
            cache.clear();
        }
        let built = RegexBuilder::new(pattern)
            .size_limit(1 << 20)
            .dfa_size_limit(1 << 20)
            .build()
            .ok()
            .map(Arc::new);
        if built.is_none() {
            tracing::debug!(pattern, "rule pattern does not compile");
        }
        cache.insert(pattern.to_string(), built.clone());
        built
    })
}

/// A glob as a regular expression: `*` is anything but `/`, `**` is anything
/// (and takes a following `/` with it), `?` is one character other than `/`.
pub(crate) fn glob_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("(?s)^");
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '*' && chars.get(i + 1) == Some(&'*') {
            regex.push_str(".*");
            i += 2;
            if chars.get(i) == Some(&'/') {
                i += 1;
            }
        } else if ch == '*' {
            regex.push_str("[^/]*");
            i += 1;
        } else if ch == '?' {
            regex.push_str("[^/]");
            i += 1;
        } else {
            regex.push_str(&regex::escape(&ch.to_string()));
            i += 1;
        }
    }
    regex.push('$');
    regex
}

/// Whether `input` matches the glob as a whole.
pub(crate) fn glob_match(pattern: &str, input: &str) -> bool {
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return false;
    }
    compiled(&glob_to_regex(pattern)).is_some_and(|re| re.is_match(input))
}

/// Whether the pattern finds a match anywhere in `input`.
pub(crate) fn regex_search(pattern: &str, input: &str) -> bool {
    compiled(pattern).is_some_and(|re| re.is_match(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(text: &str) -> String {
        let value: Value = serde_json::from_str(text).unwrap();
        value_to_text(&value)
    }

    #[test]
    fn numbers_read_like_javascript() {
        assert_eq!(num("1.0"), "1");
        assert_eq!(num("42"), "42");
        assert_eq!(num("-0.5"), "-0.5");
        assert_eq!(num("1.5"), "1.5");
        assert_eq!(num("1e22"), "1e+22");
        assert_eq!(num("1.5e-7"), "1.5e-7");
        assert_eq!(num("0.000001"), "0.000001");
        assert_eq!(num("1e20"), "100000000000000000000");
        assert_eq!(num("-0.0"), "0");
    }

    #[test]
    fn json_keeps_key_order_and_number_style() {
        let value: Value = serde_json::from_str(r#"{"b":1.0,"a":[true,null,"x\"y"]}"#).unwrap();
        assert_eq!(to_json(&value), r#"{"b":1,"a":[true,null,"x\"y"]}"#);
    }

    #[test]
    fn paths() {
        assert_eq!(
            parse_path(r#"a.b[0]["c.d"]"#, false).unwrap(),
            vec!["a", "b", "0", "c.d"]
        );
        assert_eq!(parse_path("a..b", false).unwrap(), vec!["a", "b"]);
        assert!(parse_path("a b", true).is_none());
        assert_eq!(parse_path("a b", false).unwrap(), vec!["a b"]);
        assert!(parse_path("a[x]", false).is_none());
        assert!(parse_path(r#"a["x"#, false).is_none());
    }

    #[test]
    fn form_bodies() {
        let body = structured_body(
            "a=1&b=x+y&b=z%21",
            Some("application/x-www-form-urlencoded; charset=utf-8"),
        )
        .unwrap();
        assert_eq!(body, serde_json::json!({"a": "1", "b": "z!"}));
        assert!(structured_body("a=1", Some("text/plain")).is_none());
        assert!(structured_body("", None).is_none());
    }

    #[test]
    fn globs() {
        assert!(glob_match("/a/*/c", "/a/b/c"));
        assert!(!glob_match("/a/*", "/a/b/c"));
        assert!(glob_match("/a/**", "/a/b/c"));
        assert!(glob_match("/a/**/c", "/a/c"));
        assert!(glob_match("/a?c", "/abc"));
        assert!(!glob_match("/a?c", "/a/c"));
        assert!(glob_match("/a.(b)+", "/a.(b)+"));
        assert!(!glob_match("/a.b", "/axb"));
    }

    #[test]
    fn bad_patterns_never_match() {
        assert!(!regex_search("(", "("));
        assert!(!regex_search(&"a".repeat(MAX_PATTERN_CHARS + 1), "a"));
        assert!(regex_search("(?i)ABC", "xabcx"));
    }
}
