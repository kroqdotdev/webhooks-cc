//! The JSON a notification URL receives after a capture.
//!
//! The six documented fields (`slug`, `method`, `path`, `ip`, `receivedAt`,
//! `preview`) stay for custom consumers. Chat services need a message too:
//! Slack incoming webhooks (and Discord's `/slack` endpoint) answer
//! `400 no_text` without a top-level `text`, and plain Discord webhooks read
//! `content`. Both are built here from text the sender controls (the path,
//! the body preview, an email's subject), so:
//!
//! - `text` escapes `&`, `<` and `>`, which Slack otherwise reads as
//!   control sequences (`<!channel>`, `<https://evil.example|stripe.com>`);
//! - `content` is left unescaped (Discord does not decode entities) and
//!   capped below Discord's 2,000 characters, and Discord targets get
//!   `allowed_mentions: { parse: [] }` so `@everyone` in a payload pings
//!   nobody;
//! - backticks in the method and path cannot close the inline code span,
//!   and the body cannot close its code block;
//! - long paths are shortened.
//!
//! The message shows when the receiver took the capture (`Received ...`,
//! UTC with milliseconds) and a longer excerpt of the body than `preview`:
//! up to `NOTIFICATION_MESSAGE_LEN` characters for Slack, and for Discord as
//! much as fits under its cap, cut inside the code block so it still closes.

use serde_json::{Value, json};

/// Longest path shown in the message; the `path` field keeps it whole.
const PATH_SHOWN_CHARS: usize = 100;
/// Longest method shown (HTTP methods are short; anything longer is noise).
const METHOD_SHOWN_CHARS: usize = 16;
/// Discord rejects `content` over 2,000 characters; stay clear of it.
const CONTENT_MAX_CHARS: usize = 1_900;
/// The code block's fences and newlines around the body.
const CODE_BLOCK_CHARS: usize = "\n```\n".len() + "\n```".len();
/// Below this much room, a Discord message leaves the body out.
const MIN_BODY_SHOWN_CHARS: usize = 20;

/// What a notification says, borrowed from the capture.
pub(crate) struct NotificationFields<'a> {
    pub slug: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub ip: &'a str,
    /// RFC 3339 in UTC, as the payload's `receivedAt` and the message show it.
    pub received_at: &'a str,
    /// The documented `preview` field (the first 200 characters).
    pub preview: &'a str,
    /// The longer excerpt of the body the message shows.
    pub body: &'a str,
    /// The notification URL, to recognise Discord.
    pub target_url: &'a str,
}

/// Builds the notification body. Pure: no I/O, no clock.
pub(crate) fn notification_payload(fields: &NotificationFields<'_>) -> Value {
    let mut payload = json!({
        "slug": fields.slug,
        "method": fields.method,
        "path": fields.path,
        "ip": fields.ip,
        "receivedAt": fields.received_at,
        "preview": fields.preview,
        "text": message(fields, slack_escape, usize::MAX),
        "content": discord_content(fields),
    });
    if is_discord(fields.target_url) {
        payload["allowed_mentions"] = json!({ "parse": [] });
    }
    payload
}

/// The message, with `escape` applied to every part the sender controls and
/// the body cut to `body_max` characters.
fn message(fields: &NotificationFields<'_>, escape: fn(&str) -> String, body_max: usize) -> String {
    let mut text = headline(fields, escape);
    if !fields.body.is_empty() && body_max >= MIN_BODY_SHOWN_CHARS {
        let body = escape(&shorten(fields.body, body_max).replace("```", "'''"));
        text.push_str(&format!("\n```\n{body}\n```"));
    }
    text
}

/// What arrived where, and when.
fn headline(fields: &NotificationFields<'_>, escape: fn(&str) -> String) -> String {
    let slug = escape(&no_markup(fields.slug));
    let path = escape(&no_backticks(&shorten(fields.path, PATH_SHOWN_CHARS)));
    let what = if fields.method == "EMAIL" {
        format!("New email to *{slug}* (`{path}`)")
    } else {
        let method = escape(&no_backticks(&shorten(fields.method, METHOD_SHOWN_CHARS)));
        format!("New webhook on *{slug}* (`{method} {path}`)")
    };
    format!("{what}\nReceived {} (UTC)", fields.received_at)
}

/// Discord's `content`: the body gets the room the headline leaves, so the
/// code block closes; the final cut only matters for absurd paths.
fn discord_content(fields: &NotificationFields<'_>) -> String {
    let room = CONTENT_MAX_CHARS
        .saturating_sub(headline(fields, as_is).chars().count() + CODE_BLOCK_CHARS);
    shorten(&message(fields, as_is, room), CONTENT_MAX_CHARS)
}

/// Discord does not decode entities, so its text goes out unescaped.
fn as_is(s: &str) -> String {
    s.to_string()
}

/// Slack's three control characters, as its formatting docs ask.
fn slack_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A backtick would end the inline code span the method and path sit in.
fn no_backticks(s: &str) -> String {
    s.replace('`', "'")
}

/// The slug sits between `*`; it is an id, so drop anything that formats.
fn no_markup(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// At most `max` characters, ending in `…` when cut. Never splits a char.
fn shorten(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{keep}…")
}

/// Discord's webhook hosts (discord.com and discordapp.com, with ptb. and
/// canary.).
fn is_discord(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["discord.com", "discordapp.com"]
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields<'a>(
        method: &'a str,
        path: &'a str,
        preview: &'a str,
        url: &'a str,
    ) -> NotificationFields<'a> {
        NotificationFields {
            slug: "demo4slug1",
            method,
            path,
            ip: "203.0.113.9",
            received_at: "2026-10-10T08:00:00.123Z",
            preview,
            body: preview,
            target_url: url,
        }
    }

    const SLACK: &str = "https://hooks.slack.com/services/T000/B000/xxxx";
    const DISCORD: &str = "https://discord.com/api/webhooks/1/abc";

    #[test]
    fn keeps_the_six_fields_and_adds_text_and_content() {
        let payload = notification_payload(&fields("POST", "/stripe", "{\"id\":1}", SLACK));
        assert_eq!(payload["slug"], "demo4slug1");
        assert_eq!(payload["method"], "POST");
        assert_eq!(payload["path"], "/stripe");
        assert_eq!(payload["ip"], "203.0.113.9");
        assert_eq!(payload["receivedAt"], "2026-10-10T08:00:00.123Z");
        assert_eq!(payload["preview"], "{\"id\":1}");
        assert_eq!(
            payload["text"],
            "New webhook on *demo4slug1* (`POST /stripe`)\nReceived 2026-10-10T08:00:00.123Z (UTC)\n```\n{\"id\":1}\n```"
        );
        assert_eq!(payload["content"], payload["text"]);
        assert!(payload.get("allowed_mentions").is_none());
    }

    #[test]
    fn escapes_slack_control_characters_in_text_only() {
        let preview = "<!channel> & <https://evil.example|stripe.com>";
        let payload = notification_payload(&fields("POST", "/a<b>", preview, SLACK));
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("&lt;!channel&gt; &amp; &lt;https://evil.example|stripe.com&gt;"));
        assert!(text.contains("`POST /a&lt;b&gt;`"));
        assert!(!text.contains('<'));
        // Discord shows entities literally, so content keeps the raw text.
        let content = payload["content"].as_str().unwrap();
        assert!(content.contains(preview));
        // The documented fields are untouched.
        assert_eq!(payload["preview"], preview);
    }

    #[test]
    fn backticks_cannot_break_out_of_the_code() {
        let payload = notification_payload(&fields("PO`ST", "/x`y", "a ``` b", SLACK));
        let text = payload["text"].as_str().unwrap();
        assert!(text.starts_with("New webhook on *demo4slug1* (`PO'ST /x'y`)\n"));
        assert!(text.contains("\n```\na ''' b\n```"));
        assert_eq!(text.matches("```").count(), 2);
    }

    #[test]
    fn shortens_long_paths_and_caps_content() {
        let long = format!("/{}", "a".repeat(2_500));
        let payload = notification_payload(&fields("POST", &long, &"p".repeat(200), DISCORD));
        let text = payload["text"].as_str().unwrap();
        let shown = text.split('`').nth(1).unwrap();
        assert_eq!(shown.chars().count(), "POST ".len() + 100);
        assert!(shown.ends_with('…'));
        assert!(payload["content"].as_str().unwrap().chars().count() <= 1_900);
        assert_eq!(payload["path"].as_str().unwrap().len(), 2_501);
    }

    #[test]
    fn caps_content_even_when_everything_is_long() {
        let payload = notification_payload(&fields(
            &"M".repeat(500),
            &"/é".repeat(2_000),
            &"€".repeat(200),
            DISCORD,
        ));
        assert!(payload["content"].as_str().unwrap().chars().count() <= 1_900);
    }

    #[test]
    fn announces_emails_as_emails() {
        let payload = notification_payload(&fields(
            "EMAIL",
            "demo4slug1@mailhooks.cc",
            "Your code\n123456",
            SLACK,
        ));
        assert_eq!(
            payload["text"],
            "New email to *demo4slug1* (`demo4slug1@mailhooks.cc`)\nReceived 2026-10-10T08:00:00.123Z (UTC)\n```\nYour code\n123456\n```"
        );
    }

    #[test]
    fn omits_the_code_block_without_a_preview() {
        let payload = notification_payload(&fields("GET", "/", "", SLACK));
        assert_eq!(
            payload["text"],
            "New webhook on *demo4slug1* (`GET /`)\nReceived 2026-10-10T08:00:00.123Z (UTC)"
        );
    }

    #[test]
    fn shows_the_longer_body_and_keeps_preview_short() {
        // An event payload longer than the 200-character preview.
        let body = format!(
            "{{\"Application\": \"Acme\", \"Pad\": \"{}\"}}",
            "x".repeat(2_400)
        );
        let mut f = fields("POST", "/", &body[..200], SLACK);
        f.body = &body;
        let payload = notification_payload(&f);
        assert_eq!(payload["preview"].as_str().unwrap().chars().count(), 200);
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains(&body));
        assert!(text.ends_with("\"}\n```"));
    }

    #[test]
    fn discord_cuts_the_body_inside_a_closed_code_block() {
        let body = "y".repeat(2_400);
        let mut f = fields("POST", "/hooks", "", DISCORD);
        f.body = &body;
        let payload = notification_payload(&f);
        let content = payload["content"].as_str().unwrap();
        assert!(content.chars().count() <= 1_900);
        assert!(content.contains("Received 2026-10-10T08:00:00.123Z (UTC)"));
        assert!(content.ends_with("…\n```"));
        assert_eq!(content.matches("```").count(), 2);
    }

    #[test]
    fn mutes_mentions_for_discord_only() {
        for url in [
            DISCORD,
            "https://discordapp.com/api/webhooks/1/abc",
            "https://canary.discord.com/api/webhooks/1/abc",
            "https://ptb.Discord.com/api/webhooks/1/abc",
            "https://discord.com./api/webhooks/1/abc",
        ] {
            let payload = notification_payload(&fields("POST", "/", "@everyone", url));
            assert_eq!(payload["allowed_mentions"], json!({ "parse": [] }), "{url}");
        }
        for url in [
            SLACK,
            "https://notdiscord.com/x",
            "https://discord.com.evil.example/x",
            "not a url",
        ] {
            let payload = notification_payload(&fields("POST", "/", "@everyone", url));
            assert!(payload.get("allowed_mentions").is_none(), "{url}");
        }
    }

    /// One case of `notification_vectors.json`, which the web app's chat
    /// format (apps/web/lib/forwarding/chat.ts) is checked against too.
    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorFields {
        slug: String,
        method: String,
        path: String,
        ip: String,
        received_at: String,
        preview: String,
        body: String,
        target_url: String,
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    struct Vector {
        name: String,
        fields: VectorFields,
        payload: Value,
    }

    fn payload_for(f: &VectorFields) -> Value {
        notification_payload(&NotificationFields {
            slug: &f.slug,
            method: &f.method,
            path: &f.path,
            ip: &f.ip,
            received_at: &f.received_at,
            preview: &f.preview,
            body: &f.body,
            target_url: &f.target_url,
        })
    }

    #[test]
    fn matches_the_shared_vectors() {
        let vectors: Vec<Vector> =
            serde_json::from_str(include_str!("notification_vectors.json")).unwrap();
        assert!(!vectors.is_empty());
        for vector in &vectors {
            assert_eq!(
                payload_for(&vector.fields),
                vector.payload,
                "{}",
                vector.name
            );
        }
    }

    /// Fills in the expected payloads after a deliberate change:
    /// `cargo test write_shared_vectors -- --ignored`, then review the diff.
    #[test]
    #[ignore]
    fn write_shared_vectors() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/handlers/notification_vectors.json"
        );
        let mut vectors: Vec<Vector> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for vector in &mut vectors {
            vector.payload = payload_for(&vector.fields);
        }
        std::fs::write(path, serde_json::to_string_pretty(&vectors).unwrap() + "\n").unwrap();
    }

    #[test]
    fn keeps_odd_slugs_out_of_the_formatting() {
        let mut f = fields("POST", "/", "", SLACK);
        f.slug = "a*b<c>";
        let payload = notification_payload(&f);
        assert!(
            payload["text"]
                .as_str()
                .unwrap()
                .starts_with("New webhook on *abc* (`POST /`)\n")
        );
        assert_eq!(payload["slug"], "a*b<c>");
    }
}
