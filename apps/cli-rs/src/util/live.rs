//! `liveResponse` on a request, in short: what the sender got while
//! `whk tunnel --live` relayed it. The same lines for `whk requests get` and
//! the TUI's overview; the whole record is in `--json`.

use crate::cli::output::sanitize_line;
use crate::types::LiveResponse;

/// Headers shown before the rest are counted.
const HEADERS_SHOWN: usize = 5;

/// Characters and lines of the body shown.
const BODY_CHARS: usize = 500;
const BODY_LINES: usize = 8;

/// What an outcome means, after the status.
fn outcome(live: &LiveResponse) -> String {
    match live.outcome.as_str() {
        "answered" | "" => match live.ms {
            Some(ms) => format!("your app answered in {ms} ms"),
            None => "your app answered".to_string(),
        },
        "offline" => "whk was not connected".to_string(),
        "timeout" => "no answer within 25 s".to_string(),
        "unreachable" => "nothing answered on the local port".to_string(),
        "busy" => "too many live requests were waiting".to_string(),
        "refused" => "not passed back as your app sent it".to_string(),
        other => sanitize_line(other),
    }
}

/// The record in short, a line each, unindented: the status and outcome, a
/// few headers, and the start of the body.
pub fn live_response_lines(live: &LiveResponse) -> Vec<String> {
    let status = live
        .status
        .map_or_else(|| "-".to_string(), |status| status.to_string());
    let mut out = vec![format!("Status: {status} ({})", outcome(live))];
    for (name, value) in live.headers.iter().take(HEADERS_SHOWN) {
        out.push(format!("{}: {}", sanitize_line(name), sanitize_line(value)));
    }
    if live.headers.len() > HEADERS_SHOWN {
        out.push(format!(
            "... and {} more headers",
            live.headers.len() - HEADERS_SHOWN
        ));
    }
    if live.body.is_empty() {
        out.push("(no body)".to_string());
        return out;
    }
    if live.body_encoding == "base64" {
        // Four base64 characters carry three bytes.
        let bytes = live.body.trim_end_matches('=').len() * 3 / 4;
        out.push(format!(
            "(a binary body, {bytes} bytes kept; --json has it)"
        ));
        return out;
    }
    let preview: String = live.body.chars().take(BODY_CHARS).collect();
    let mut cut = live.body_truncated || preview.len() < live.body.len();
    let lines: Vec<&str> = preview.lines().collect();
    if lines.len() > BODY_LINES {
        cut = true;
    }
    out.push(String::new());
    out.extend(
        lines
            .iter()
            .take(BODY_LINES)
            .map(|line| sanitize_line(line)),
    );
    if cut {
        out.push("... (cut; --json has what was kept)".to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(json: serde_json::Value) -> LiveResponse {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn an_answer_shows_its_status_headers_and_body() {
        let live = record(serde_json::json!({
            "status": 200,
            "headers": {
                "content-type": "application/json", "x-a": "1", "x-b": "2",
                "x-c": "3", "x-d": "4", "x-e": "5", "x-f": "6"
            },
            "body": "{\"ok\":true}\nline two\u{1b}[31m",
            "bodyTruncated": false,
            "bodyEncoding": "utf8",
            "ms": 12,
            "outcome": "answered"
        }));
        let lines = live_response_lines(&live);
        assert_eq!(lines[0], "Status: 200 (your app answered in 12 ms)");
        assert_eq!(lines[1], "content-type: application/json");
        assert_eq!(lines[6], "... and 2 more headers");
        assert!(lines.contains(&"{\"ok\":true}".to_string()), "{lines:?}");
        assert!(lines.contains(&"line two[31m".to_string()), "{lines:?}");
        assert!(!lines.iter().any(|l| l.contains("cut")));
    }

    #[test]
    fn a_stand_in_says_what_happened() {
        let live = record(serde_json::json!({
            "status": 504, "headers": {}, "body": "", "bodyTruncated": false,
            "bodyEncoding": "utf8", "ms": null, "outcome": "timeout"
        }));
        assert_eq!(
            live_response_lines(&live),
            ["Status: 504 (no answer within 25 s)", "(no body)"]
        );
    }

    #[test]
    fn long_and_binary_bodies_are_cut_short() {
        let long = record(serde_json::json!({
            "status": 200, "headers": {}, "body": "x\n".repeat(50),
            "bodyTruncated": true, "bodyEncoding": "utf8", "ms": 5, "outcome": "answered"
        }));
        let lines = live_response_lines(&long);
        assert_eq!(lines.len(), 1 + 1 + BODY_LINES + 1, "{lines:?}");
        assert!(lines.last().unwrap().starts_with("... (cut"));
        let binary = record(serde_json::json!({
            "status": 200, "headers": {}, "body": "AAECAw==",
            "bodyEncoding": "base64", "outcome": "answered"
        }));
        assert_eq!(
            live_response_lines(&binary)[1],
            "(a binary body, 4 bytes kept; --json has it)"
        );
    }

    #[test]
    fn a_request_reads_the_record_from_the_api() {
        let request: crate::types::CapturedRequest = serde_json::from_value(serde_json::json!({
            "id": "r1", "endpointId": "e1", "method": "POST", "path": "/slack",
            "receivedAt": 1,
            "liveResponse": {
                "status": 200, "headers": {"content-type": "text/plain"}, "body": "hi",
                "bodyTruncated": false, "bodyEncoding": "utf8", "ms": 9, "outcome": "answered"
            }
        }))
        .unwrap();
        let live = request.live_response.as_deref().unwrap();
        assert_eq!(live.status, Some(200));
        assert_eq!(live.body, "hi");
        // --json passes it on as the API sent it.
        let back = serde_json::to_value(&request).unwrap();
        assert_eq!(back["liveResponse"]["bodyEncoding"], "utf8");
        assert_eq!(back["liveResponse"]["ms"], 9);
        let without: crate::types::CapturedRequest = serde_json::from_value(serde_json::json!({
            "id": "r2", "endpointId": "e1", "method": "GET", "path": "/", "receivedAt": 1
        }))
        .unwrap();
        assert!(without.live_response.is_none());
        assert!(
            serde_json::to_value(&without)
                .unwrap()
                .get("liveResponse")
                .is_none()
        );
    }
}
