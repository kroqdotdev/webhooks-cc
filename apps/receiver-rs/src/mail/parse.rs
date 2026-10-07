//! MIME parsing for captured email.
//!
//! One raw message becomes three things:
//! - the `email` document stored in `requests.email` (addresses, subject,
//!   text and HTML parts, attachment list),
//! - the flat header map stored in `requests.headers`, raw values unfolded,
//! - the body copy stored in `requests.body`: the whole raw message when it
//!   is at most 1 MiB, otherwise only its header block, flagged as cut.
//!
//! Everything is bounded: the sender controls every byte, and a 10 MiB
//! message of nothing but addresses must not turn into a gigabyte of JSON.
//! Attachment contents are never stored; v1 lists name, type and size only.

use std::borrow::Cow;
use std::collections::HashMap;

use mail_parser::{Address, HeaderValue, Message, MessageParser, MimeHeaders, PartType};
use serde_json::{Map, Value, json};

use crate::handlers::webhook::{classify_body, strip_nul};

/// Raw messages up to this size are stored whole.
pub const MAX_STORED_RAW: usize = 1024 * 1024;
/// The text and HTML parts are each stored up to this many bytes.
pub const MAX_PART_BYTES: usize = 256 * 1024;
/// A header section longer than this is cut before parsing (and the body is
/// not parsed at all): no legitimate message comes close.
const MAX_HEADER_SECTION: usize = 1024 * 1024;
/// A message over `MAX_STORED_RAW` keeps at most this much of its header block.
const MAX_STORED_HEADER_BLOCK: usize = 256 * 1024;
const MAX_HEADER_NAMES: usize = 200;
const MAX_HEADER_NAME: usize = 256;
/// Per header name, after repeated headers are joined.
const MAX_HEADER_VALUE: usize = 16 * 1024;
/// All header values together.
const MAX_HEADER_MAP_BYTES: usize = 512 * 1024;
const MAX_ADDRESSES: usize = 100;
const MAX_SUBJECT: usize = 4 * 1024;
/// Names, addresses, file names, content and message IDs.
const MAX_SHORT: usize = 1024;
const MAX_REFERENCES: usize = 50;
const MAX_ATTACHMENTS: usize = 100;
/// Characters of text used for the notification preview.
const PREVIEW_CHARS: usize = 400;

pub struct ParsedEmail {
    /// Root headers, lowercase names, values unfolded; repeated headers (such
    /// as `received`) joined with a newline in message order.
    pub headers: HashMap<String, String>,
    /// The parsed document; the handler adds the per-recipient fields.
    pub doc: Map<String, Value>,
    pub subject: Option<String>,
    /// Start of the text part, for the notification preview.
    pub preview: String,
}

pub struct StoredBody {
    pub text: String,
    pub raw: Option<Vec<u8>>,
    /// True when only the header block was kept.
    pub truncated: bool,
}

/// Parse a raw RFC 5322 message. Never fails: input mail-parser cannot read
/// yields the empty document with `parse_error: true`, and the raw message is
/// still stored.
pub fn parse_message(raw: &[u8]) -> ParsedEmail {
    let (input, headers_oversized) = bounded_input(raw);
    let mut doc = empty_doc();
    doc.insert("headers_oversized".into(), Value::Bool(headers_oversized));

    let Some(message) = MessageParser::default().parse(input.as_ref()) else {
        doc.insert("parse_error".into(), Value::Bool(true));
        return ParsedEmail {
            headers: HashMap::new(),
            doc,
            subject: None,
            preview: String::new(),
        };
    };

    let headers = header_map(&message);
    let subject = message.subject().map(|s| short(s, MAX_SUBJECT));

    let mut addresses_truncated = false;
    for (key, value) in [
        ("from", message.from()),
        ("sender", message.sender()),
        ("to", message.to()),
        ("cc", message.cc()),
        ("reply_to", message.reply_to()),
    ] {
        let (list, cut) = addresses(value);
        addresses_truncated |= cut;
        doc.insert(key.into(), list);
    }
    doc.insert(
        "addresses_truncated".into(),
        Value::Bool(addresses_truncated),
    );

    doc.insert("subject".into(), json!(subject));
    doc.insert(
        "date".into(),
        json!(
            message
                .date()
                .filter(|d| d.is_valid())
                .map(|d| d.to_rfc3339())
        ),
    );
    doc.insert(
        "message_id".into(),
        json!(message.message_id().map(|s| short(s, MAX_SHORT))),
    );
    doc.insert("in_reply_to".into(), references(message.in_reply_to()));

    let (text, text_truncated, text_from_html) = text_body(&message);
    doc.insert("text".into(), Value::String(text.clone()));
    doc.insert("text_truncated".into(), Value::Bool(text_truncated));
    doc.insert("text_from_html".into(), Value::Bool(text_from_html));

    let (html, html_truncated) = html_body(&message);
    doc.insert("html".into(), json!(html));
    doc.insert("html_truncated".into(), Value::Bool(html_truncated));

    let mut attachments = Vec::new();
    for part in message.attachments().take(MAX_ATTACHMENTS) {
        let content_type = part.content_type().map(|ct| {
            let full = match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub),
                None => ct.ctype().to_string(),
            };
            short(&full.to_ascii_lowercase(), MAX_SHORT)
        });
        attachments.push(json!({
            "filename": part.attachment_name().map(|s| short(s, MAX_SHORT)),
            "content_type": content_type,
            "size": part.contents().len(),
            "content_id": part.content_id().map(|s| short(s, MAX_SHORT)),
            "inline": part.content_disposition().is_some_and(|d| d.is_inline()),
        }));
    }
    doc.insert("attachments".into(), Value::Array(attachments));
    doc.insert(
        "attachments_truncated".into(),
        Value::Bool(message.attachment_count() > MAX_ATTACHMENTS),
    );

    let preview: String = text.chars().take(PREVIEW_CHARS).collect();

    ParsedEmail {
        headers,
        doc,
        subject,
        preview,
    }
}

/// The copy stored in `requests.body` (and `body_raw` when the text copy is
/// lossy), following the same rules as HTTP bodies.
pub fn stored_body(raw: &[u8]) -> StoredBody {
    if raw.len() <= MAX_STORED_RAW {
        let (text, raw_copy) = classify_body(raw);
        return StoredBody {
            text,
            raw: raw_copy,
            truncated: false,
        };
    }
    let window = &raw[..raw.len().min(MAX_STORED_HEADER_BLOCK)];
    let end = header_block_end(window).unwrap_or(window.len());
    let (text, raw_copy) = classify_body(&raw[..end]);
    StoredBody {
        text,
        raw: raw_copy,
        truncated: true,
    }
}

/// Every key the document always has, so consumers never meet a partial shape.
fn empty_doc() -> Map<String, Value> {
    let mut doc = Map::new();
    for key in [
        "from",
        "sender",
        "to",
        "cc",
        "reply_to",
        "in_reply_to",
        "attachments",
    ] {
        doc.insert(key.into(), Value::Array(Vec::new()));
    }
    for key in ["subject", "date", "message_id", "html"] {
        doc.insert(key.into(), Value::Null);
    }
    doc.insert("text".into(), Value::String(String::new()));
    for key in [
        "addresses_truncated",
        "text_truncated",
        "text_from_html",
        "html_truncated",
        "attachments_truncated",
        "headers_oversized",
        "parse_error",
    ] {
        doc.insert(key.into(), Value::Bool(false));
    }
    doc
}

/// The message as parsed: unchanged, unless its header section is absurdly
/// long, in which case only the first `MAX_HEADER_SECTION` bytes of headers
/// are parsed and the body is dropped.
fn bounded_input(raw: &[u8]) -> (Cow<'_, [u8]>, bool) {
    let header_len = header_block_end(raw).unwrap_or(raw.len());
    if header_len <= MAX_HEADER_SECTION {
        return (Cow::Borrowed(raw), false);
    }
    let window = &raw[..MAX_HEADER_SECTION];
    let cut = window
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(MAX_HEADER_SECTION);
    let mut owned = Vec::with_capacity(cut + 4);
    owned.extend_from_slice(&raw[..cut]);
    // End the header section with exactly one blank line and no body.
    if owned.ends_with(b"\n") {
        owned.extend_from_slice(b"\r\n");
    } else {
        owned.extend_from_slice(b"\r\n\r\n");
    }
    (Cow::Owned(owned), true)
}

/// Index just past the blank line that ends the header block.
fn header_block_end(raw: &[u8]) -> Option<usize> {
    let crlf = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
    let lf = raw.windows(2).position(|w| w == b"\n\n").map(|i| i + 2);
    match (crlf, lf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Root headers in message order. Values are read from the raw bytes and
/// decoded lossily, so a header with 8-bit garbage is kept rather than lost.
fn header_map(message: &Message<'_>) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let Some(root) = message.parts.first() else {
        return map;
    };
    let raw = message.raw_message();
    let mut total = 0usize;
    for header in &root.headers {
        let name = clean(header.name.as_str()).trim().to_ascii_lowercase();
        if name.is_empty() || name.len() > MAX_HEADER_NAME {
            continue;
        }
        if !map.contains_key(&name) && map.len() >= MAX_HEADER_NAMES {
            continue;
        }
        let start = header.offset_start as usize;
        let end = (header.offset_end as usize).min(raw.len());
        if start > end {
            continue;
        }
        let value = clean(&unfold(&String::from_utf8_lossy(&raw[start..end])));
        let existing = map.get(&name).map_or(0, String::len);
        let separator = usize::from(existing > 0);
        let room = MAX_HEADER_VALUE
            .saturating_sub(existing + separator)
            .min(MAX_HEADER_MAP_BYTES.saturating_sub(total + separator));
        if room == 0 {
            continue;
        }
        let (piece, _) = truncate_bytes(&value, room);
        let entry = map.entry(name).or_default();
        if separator == 1 {
            entry.push('\n');
        }
        entry.push_str(&piece);
        total += piece.len() + separator;
    }
    map
}

/// RFC 5322 unfolding: a line break followed by whitespace continues the
/// previous line. Each continuation is joined with a single space.
fn unfold(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for (i, line) in value.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line = if i == 0 { line } else { line.trim_start() };
        if line.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
    }
    out.trim().to_string()
}

/// All text parts in order (a multipart/mixed message can have several),
/// joined by a blank line. For HTML-only mail this is mail-parser's HTML to
/// text conversion, flagged with `text_from_html`.
fn text_body(message: &Message<'_>) -> (String, bool, bool) {
    let mut joined = String::new();
    let mut from_html = false;
    for i in 0..message.text_body_count() {
        let Some(part) = message.text_part(i as u32) else {
            continue;
        };
        let text = match &part.body {
            PartType::Text(text) => Cow::Borrowed(text.as_ref()),
            PartType::Html(_) => {
                from_html = true;
                match message.body_text(i) {
                    Some(text) => text,
                    None => continue,
                }
            }
            _ => continue,
        };
        if !joined.is_empty() {
            joined.push_str("\n\n");
        }
        joined.push_str(&text);
        if joined.len() > MAX_PART_BYTES {
            break;
        }
    }
    let (text, cut) = truncate_bytes(&clean(&joined), MAX_PART_BYTES);
    (text, cut, from_html)
}

/// Real HTML parts only; plain-text mail has no HTML.
fn html_body(message: &Message<'_>) -> (Option<String>, bool) {
    let mut joined = String::new();
    for i in 0..message.html_body_count() {
        if let Some(part) = message.html_part(i as u32)
            && let PartType::Html(html) = &part.body
        {
            if !joined.is_empty() {
                joined.push('\n');
            }
            joined.push_str(html);
            if joined.len() > MAX_PART_BYTES {
                break;
            }
        }
    }
    if joined.is_empty() {
        return (None, false);
    }
    let (html, cut) = truncate_bytes(&clean(&joined), MAX_PART_BYTES);
    (Some(html), cut)
}

/// At most `MAX_ADDRESSES` entries, each field capped. The flag says whether
/// any entries were dropped.
fn addresses(value: Option<&Address<'_>>) -> (Value, bool) {
    let Some(address) = value else {
        return (Value::Array(Vec::new()), false);
    };
    let mut list = Vec::new();
    let mut truncated = false;
    for (i, a) in address.iter().enumerate() {
        if i == MAX_ADDRESSES {
            truncated = true;
            break;
        }
        list.push(json!({
            "name": a.name.as_deref().map(|s| short(s, MAX_SHORT)),
            "address": a.address.as_deref().map(|s| short(s, MAX_SHORT)),
        }));
    }
    (Value::Array(list), truncated)
}

fn references(value: &HeaderValue<'_>) -> Value {
    let items: Vec<Value> = if let Some(list) = value.as_text_list() {
        list.iter()
            .take(MAX_REFERENCES)
            .map(|s| Value::String(short(s, MAX_SHORT)))
            .collect()
    } else if let Some(text) = value.as_text() {
        vec![Value::String(short(text, MAX_SHORT))]
    } else {
        Vec::new()
    };
    Value::Array(items)
}

/// NUL-free (Postgres rejects U+0000 in text and jsonb) and at most `max`
/// bytes.
fn short(s: &str, max: usize) -> String {
    truncate_bytes(&clean(s), max).0
}

fn clean(s: &str) -> String {
    strip_nul(s).into_owned()
}

/// Cut `s` to at most `max` bytes without splitting a character.
fn truncate_bytes(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE: &str = "From: Alice <alice@example.com>\r\n\
To: abc123@mailhooks.cc, Bob <bob@example.com>\r\n\
Subject: Welcome aboard\r\n\
Date: Wed, 07 Oct 2026 12:00:00 +0000\r\n\
Message-ID: <m1@example.com>\r\n\
\r\n\
Your code is 123456.\r\n";

    /// Serialised JSON spells U+0000 as an escape, never as a raw byte.
    fn has_nul(value: &Value) -> bool {
        value.to_string().contains("\\u0000")
    }

    #[test]
    fn parses_a_plain_message() {
        let parsed = parse_message(SIMPLE.as_bytes());
        assert_eq!(parsed.subject.as_deref(), Some("Welcome aboard"));
        assert_eq!(parsed.doc["subject"], "Welcome aboard");
        assert_eq!(parsed.doc["from"][0]["address"], "alice@example.com");
        assert_eq!(parsed.doc["from"][0]["name"], "Alice");
        assert_eq!(parsed.doc["to"].as_array().unwrap().len(), 2);
        assert_eq!(parsed.doc["message_id"], "m1@example.com");
        assert!(
            parsed.doc["date"]
                .as_str()
                .unwrap()
                .starts_with("2026-10-07T12:00:00")
        );
        assert!(parsed.doc["text"].as_str().unwrap().contains("123456"));
        assert_eq!(parsed.doc["text_from_html"], false);
        assert_eq!(parsed.doc["html"], Value::Null);
        assert_eq!(parsed.doc["attachments"], json!([]));
        assert_eq!(parsed.doc["parse_error"], false);
        assert_eq!(parsed.headers["subject"], "Welcome aboard");
        assert!(parsed.preview.contains("123456"));
    }

    #[test]
    fn always_has_the_same_document_keys() {
        let full = parse_message(SIMPLE.as_bytes());
        let failed = parse_message(b"");
        let mut a: Vec<&String> = full.doc.keys().collect();
        let mut b: Vec<&String> = failed.doc.keys().collect();
        a.sort();
        b.sort();
        assert_eq!(a, b);
        assert_eq!(failed.doc["parse_error"], true);
        assert!(failed.headers.is_empty());
    }

    #[test]
    fn decodes_encoded_words_in_the_document_but_keeps_raw_headers() {
        let raw = "From: =?UTF-8?B?w4VzZQ==?= <ase@example.com>\r\n\
Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\n\r\nhi\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.doc["subject"], "Grüße");
        assert_eq!(parsed.doc["from"][0]["name"], "Åse");
        assert_eq!(parsed.headers["subject"], "=?UTF-8?Q?Gr=C3=BC=C3=9Fe?=");
    }

    #[test]
    fn keeps_headers_that_are_not_utf8() {
        let mut raw = b"Subject: caf".to_vec();
        raw.push(0xE9); // Latin-1 e acute, not valid UTF-8
        raw.extend_from_slice(b"\r\nX-Other: ok\r\n\r\nbody\r\n");
        let parsed = parse_message(&raw);
        assert_eq!(parsed.headers["subject"], "caf\u{FFFD}");
        assert_eq!(parsed.headers["x-other"], "ok");
    }

    #[test]
    fn unfolds_and_joins_repeated_headers() {
        let raw = "Received: from a.example\r\n\tby mx.mailhooks.cc;\r\n Wed, 7 Oct 2026\r\n\
Received: from b.example\r\n\
Subject: x\r\n\r\nbody\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(
            parsed.headers["received"],
            "from a.example by mx.mailhooks.cc; Wed, 7 Oct 2026\nfrom b.example"
        );
    }

    #[test]
    fn many_repeated_headers_do_not_push_out_the_rest() {
        let mut raw = String::new();
        for i in 0..500 {
            raw.push_str(&format!("Received: from relay{i}.example\r\n"));
        }
        raw.push_str("Subject: still here\r\nFrom: a@example.com\r\n\r\nbody\r\n");
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.headers["subject"], "still here");
        assert_eq!(parsed.headers["from"], "a@example.com");
        assert!(parsed.headers["received"].len() <= MAX_HEADER_VALUE);
    }

    #[test]
    fn bounds_header_names_and_total_size() {
        let mut raw = String::new();
        for i in 0..(MAX_HEADER_NAMES + 50) {
            raw.push_str(&format!("X-H{i}: {}\r\n", "v".repeat(MAX_HEADER_VALUE)));
        }
        raw.push_str("\r\nbody\r\n");
        let parsed = parse_message(raw.as_bytes());
        assert!(parsed.headers.len() <= MAX_HEADER_NAMES);
        let total: usize = parsed.headers.values().map(String::len).sum();
        assert!(total <= MAX_HEADER_MAP_BYTES);
        assert!(parsed.headers.values().all(|v| v.len() <= MAX_HEADER_VALUE));
    }

    #[test]
    fn caps_address_lists_and_long_fields() {
        let to: Vec<String> = (0..5_000).map(|i| format!("u{i}@example.com")).collect();
        let raw = format!(
            "To: {}\r\nSubject: {}\r\n\r\nbody\r\n",
            to.join(",\r\n "),
            "s".repeat(MAX_SUBJECT * 4)
        );
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.doc["to"].as_array().unwrap().len(), MAX_ADDRESSES);
        assert_eq!(parsed.doc["addresses_truncated"], true);
        assert_eq!(parsed.doc["subject"].as_str().unwrap().len(), MAX_SUBJECT);
        assert_eq!(parsed.subject.unwrap().len(), MAX_SUBJECT);
    }

    #[test]
    fn cuts_an_absurd_header_section_before_parsing() {
        let mut raw = String::from("Subject: first\r\nTo: ");
        while raw.len() < MAX_HEADER_SECTION + 100_000 {
            raw.push_str("x@example.com,\r\n ");
        }
        raw.push_str("y@example.com\r\n\r\nbody text\r\n");
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.doc["headers_oversized"], true);
        assert_eq!(parsed.doc["subject"], "first");
        assert_eq!(parsed.doc["text"], "");
        assert!(
            serde_json::to_vec(&Value::Object(parsed.doc))
                .unwrap()
                .len()
                < 64 * 1024
        );
    }

    #[test]
    fn reads_multipart_alternative_and_attachments() {
        let raw = "From: shop@example.com\r\n\
To: abc@mailhooks.cc\r\n\
Subject: Receipt\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
\r\n\
--outer\r\n\
Content-Type: multipart/alternative; boundary=\"inner\"\r\n\
\r\n\
--inner\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Thanks for your order\r\n\
--inner\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Thanks for your <b>order</b></p>\r\n\
--inner--\r\n\
--outer\r\n\
Content-Type: application/pdf; name=\"receipt.pdf\"\r\n\
Content-Disposition: attachment; filename=\"receipt.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQKJcfsj6IK\r\n\
--outer--\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert!(
            parsed.doc["text"]
                .as_str()
                .unwrap()
                .contains("Thanks for your order")
        );
        assert_eq!(parsed.doc["text_from_html"], false);
        assert!(
            parsed.doc["html"]
                .as_str()
                .unwrap()
                .contains("<b>order</b>")
        );
        let attachments = parsed.doc["attachments"].as_array().unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0]["filename"], "receipt.pdf");
        assert_eq!(attachments[0]["content_type"], "application/pdf");
        assert_eq!(attachments[0]["size"], 15);
        assert_eq!(attachments[0]["inline"], false);
        assert_eq!(parsed.doc["attachments_truncated"], false);
    }

    #[test]
    fn joins_every_inline_text_part() {
        let raw = "Subject: footer\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain\r\n\
\r\n\
Main text\r\n\
--b\r\n\
Content-Type: text/plain\r\n\
Content-Disposition: inline\r\n\
\r\n\
Footer text\r\n\
--b--\r\n";
        let parsed = parse_message(raw.as_bytes());
        let text = parsed.doc["text"].as_str().unwrap();
        assert!(text.contains("Main text"));
        assert!(text.contains("Footer text"));
    }

    #[test]
    fn flags_text_derived_from_html_only_mail() {
        let raw =
            "Subject: html only\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.doc["text_from_html"], true);
        assert!(parsed.doc["text"].as_str().unwrap().contains("Hello"));
        assert!(
            parsed.doc["html"]
                .as_str()
                .unwrap()
                .contains("<b>there</b>")
        );
    }

    #[test]
    fn converts_legacy_charsets() {
        let mut raw =
            b"Subject: latin\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\nK".to_vec();
        raw.push(0xF8); // o with stroke in ISO-8859-1
        raw.extend_from_slice(b"benhavn\r\n");
        let parsed = parse_message(&raw);
        assert!(parsed.doc["text"].as_str().unwrap().contains("København"));
    }

    #[test]
    fn drops_invalid_dates() {
        let raw = "Subject: d\r\nDate: Wed, 99 Foo 9999 99:99:99 +0339\r\n\r\nx\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert_eq!(parsed.doc["date"], Value::Null);
    }

    #[test]
    fn strips_nul_from_every_stored_string_and_key() {
        let raw = "Subject: a\0b\r\nX-A\0b: c\0d\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\r\n\
--b\r\nContent-Type: text/plain\r\n\r\ntext\0here\r\n\
--b\r\nContent-Type: appli\0cation/x-thing\r\nContent-Disposition: attachment; filename=\"a\0b.bin\"\r\n\r\nzz\r\n\
--b--\r\n";
        let parsed = parse_message(raw.as_bytes());
        assert!(!has_nul(&Value::Object(parsed.doc.clone())));
        let headers = serde_json::to_value(&parsed.headers).unwrap();
        assert!(!has_nul(&headers));
    }

    #[test]
    fn caps_the_text_part() {
        let raw = format!("Subject: big\r\n\r\n{}", "é".repeat(MAX_PART_BYTES));
        let parsed = parse_message(raw.as_bytes());
        let text = parsed.doc["text"].as_str().unwrap();
        assert!(text.len() <= MAX_PART_BYTES);
        assert_eq!(parsed.doc["text_truncated"], true);
    }

    #[test]
    fn stores_small_messages_whole() {
        let body = stored_body(SIMPLE.as_bytes());
        assert_eq!(body.text, SIMPLE);
        assert!(body.raw.is_none());
        assert!(!body.truncated);
    }

    #[test]
    fn keeps_raw_bytes_for_invalid_utf8() {
        let raw = b"Subject: x\r\n\r\n\xff\xfe\r\n";
        let body = stored_body(raw);
        assert_eq!(body.raw.as_deref(), Some(&raw[..]));
        assert!(!body.truncated);
    }

    #[test]
    fn keeps_only_the_header_block_of_large_messages() {
        let mut raw = SIMPLE.as_bytes().to_vec();
        raw.extend(std::iter::repeat_n(b'x', MAX_STORED_RAW));
        let body = stored_body(&raw);
        assert!(body.truncated);
        assert!(body.text.ends_with("Message-ID: <m1@example.com>\r\n\r\n"));
        assert!(!body.text.contains("Your code"));
    }

    #[test]
    fn caps_a_large_message_without_a_header_terminator() {
        let raw = vec![b'a'; MAX_STORED_RAW + 10];
        let body = stored_body(&raw);
        assert!(body.truncated);
        assert_eq!(body.text.len(), MAX_STORED_HEADER_BLOCK);
    }
}
