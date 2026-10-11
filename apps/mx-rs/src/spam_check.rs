//! Spam scoring by a local rspamd.
//!
//! Like the authentication checks, the verdict is recorded for the user to
//! inspect and never decides whether mail is accepted: people test their own
//! mail here, and test mail often looks like spam. The listener's limits stay
//! the abuse control.
//!
//! rspamd runs on the same box and answers on localhost (`MX_RSPAMD_URL`).
//! Each check holds one of a fixed number of slots and gets a time budget; a
//! check that cannot run (no slot, timeout, rspamd down, an answer that is
//! not rspamd's) records why instead of a score, and the mail goes on.
//!
//! Only a summary is kept: the score, the threshold, rspamd's suggested
//! action and the rules that fired that weigh most.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

/// Rules kept, the heaviest first.
const MAX_SYMBOLS: usize = 20;
/// Options kept per rule, and their length.
const MAX_OPTIONS: usize = 3;
const MAX_OPTION_CHARS: usize = 200;
/// Longest rule name or action kept.
const MAX_NAME_CHARS: usize = 100;
/// The summary as JSON stays under this, well inside the receiver's 16 KiB
/// for metadata (which stores nothing at all past it): the rules' options go
/// first, then the lightest rules, never the verdict.
const MAX_SUMMARY_BYTES: usize = 12 * 1024;

/// What rspamd is told about a message besides its bytes.
pub struct SpamRequest {
    pub ip: std::net::IpAddr,
    pub helo: String,
    pub mail_from: String,
    pub recipients: Vec<String>,
    /// The client's forward-confirmed reverse DNS name, if any.
    pub hostname: Option<String>,
    /// Shown in rspamd's log, to match a verdict with a message.
    pub queue_id: String,
    /// TLS version and cipher, when the session used STARTTLS.
    pub tls: Option<(String, String)>,
    pub raw: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct SpamChecker {
    client: reqwest::Client,
    url: String,
    budget: Duration,
    slots: Arc<Semaphore>,
}

impl SpamChecker {
    /// `base_url` is rspamd's normal worker, e.g. "http://127.0.0.1:11333".
    pub fn new(base_url: &str, budget: Duration, slots: usize) -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .expect("reqwest client"),
            url: format!("{}/checkv2", base_url.trim_end_matches('/')),
            budget,
            slots: Arc::new(Semaphore::new(slots.max(1))),
        }
    }

    /// The verdict for one message, or `{ "error": ... }` when it could not
    /// be had: "busy" (every slot taken), "timeout", "unavailable" (rspamd
    /// did not answer or answered an error), "invalid" (the answer was not
    /// rspamd's JSON) or "skipped" (rspamd's settings skipped the message).
    pub async fn check(&self, request: SpamRequest) -> Value {
        let Ok(_slot) = self.slots.clone().try_acquire_owned() else {
            return json!({ "error": "busy" });
        };
        let response = self
            .client
            .post(&self.url)
            .timeout(self.budget)
            .headers(headers(&request))
            .body(request.raw.as_ref().clone())
            .send()
            .await;
        let response = match response {
            Ok(response) if response.status().is_success() => response,
            Ok(_) => return json!({ "error": "unavailable" }),
            Err(e) if e.is_timeout() => return json!({ "error": "timeout" }),
            Err(_) => return json!({ "error": "unavailable" }),
        };
        match tokio::time::timeout(self.budget, response.json::<Value>()).await {
            Ok(Ok(answer)) => summarize(&answer),
            Ok(Err(_)) => json!({ "error": "invalid" }),
            Err(_) => json!({ "error": "timeout" }),
        }
    }
}

/// rspamd's request headers (its HTTP protocol): who sent the message, to
/// whom, and how. A value no header can hold is left out.
fn headers(request: &SpamRequest) -> HeaderMap {
    let mut map = HeaderMap::new();
    let mut add = |name: &'static str, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            map.append(HeaderName::from_static(name), value);
        }
    };
    add("ip", &request.ip.to_string());
    if !request.helo.is_empty() {
        add("helo", &request.helo);
    }
    if !request.mail_from.is_empty() {
        add("from", &request.mail_from);
    }
    for recipient in &request.recipients {
        add("rcpt", recipient);
    }
    if let Some(hostname) = &request.hostname {
        add("hostname", hostname);
    }
    add("queue-id", &request.queue_id);
    if let Some((version, cipher)) = &request.tls {
        add("tls-version", version);
        add("tls-cipher", cipher);
    }
    map
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn rounded(value: f64) -> Value {
    serde_json::Number::from_f64((value * 100.0).round() / 100.0)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// The part of rspamd's answer worth keeping, bounded: `score`, `required`,
/// `action` and up to `MAX_SYMBOLS` rules ordered by their weight.
pub fn summarize(answer: &Value) -> Value {
    // `is_skipped` is also set when a rule ends the scan early with a
    // verdict (GTUBE does), so a score that is there counts.
    let (Some(score), Some(required), Some(action)) = (
        answer.get("score").and_then(Value::as_f64),
        answer.get("required_score").and_then(Value::as_f64),
        answer.get("action").and_then(Value::as_str),
    ) else {
        let skipped = answer.get("is_skipped").and_then(Value::as_bool) == Some(true);
        return json!({ "error": if skipped { "skipped" } else { "invalid" } });
    };

    let mut symbols: Vec<(f64, Value)> = answer
        .get("symbols")
        .and_then(Value::as_object)
        .map(|symbols| {
            symbols
                .iter()
                .map(|(key, symbol)| {
                    let name = symbol.get("name").and_then(Value::as_str).unwrap_or(key);
                    let weight = symbol.get("score").and_then(Value::as_f64).unwrap_or(0.0);
                    let options: Vec<Value> = symbol
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(Value::as_str)
                                .take(MAX_OPTIONS)
                                .map(|option| Value::String(cut(option, MAX_OPTION_CHARS)))
                                .collect()
                        })
                        .unwrap_or_default();
                    let mut entry = Map::new();
                    entry.insert("name".into(), Value::String(cut(name, MAX_NAME_CHARS)));
                    entry.insert("score".into(), rounded(weight));
                    if !options.is_empty() {
                        entry.insert("options".into(), Value::Array(options));
                    }
                    (weight, Value::Object(entry))
                })
                .collect()
        })
        .unwrap_or_default();
    // Heaviest first, either way; names break ties, so the order is stable.
    symbols.sort_by(|(a, left), (b, right)| {
        b.abs().total_cmp(&a.abs()).then_with(|| {
            let name = |value: &Value| value["name"].as_str().unwrap_or("").to_string();
            name(left).cmp(&name(right))
        })
    });
    symbols.truncate(MAX_SYMBOLS);
    // A scan ended early (GTUBE) names the module that decided instead of rules.
    if symbols.is_empty()
        && let Some(module) = answer.get("passthrough_module").and_then(Value::as_str)
    {
        symbols.push((
            score,
            json!({ "name": cut(module, MAX_NAME_CHARS), "score": rounded(score) }),
        ));
    }

    let mut summary = json!({
        "score": rounded(score),
        "required": rounded(required),
        "action": cut(action, MAX_NAME_CHARS),
        "symbols": symbols.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>(),
    });
    fit(&mut summary);
    summary
}

fn size(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

/// Shrinks a summary to MAX_SUMMARY_BYTES: options first, then the lightest rules.
fn fit(summary: &mut Value) {
    if size(summary) <= MAX_SUMMARY_BYTES {
        return;
    }
    if let Some(symbols) = summary["symbols"].as_array_mut() {
        for symbol in symbols.iter_mut() {
            if let Some(entry) = symbol.as_object_mut() {
                entry.remove("options");
            }
        }
    }
    while size(summary) > MAX_SUMMARY_BYTES {
        match summary["symbols"].as_array_mut() {
            Some(symbols) if !symbols.is_empty() => {
                symbols.pop();
            }
            _ => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn request() -> SpamRequest {
        SpamRequest {
            ip: "203.0.113.9".parse().unwrap(),
            helo: "mail.example.com".into(),
            mail_from: "sender@example.com".into(),
            recipients: vec!["abc+tag@mailhooks.cc".into(), "def@mailhooks.cc".into()],
            hostname: Some("mail.example.com".into()),
            queue_id: "q1".into(),
            tls: Some(("TLSv1_3".into(), "TLS13_AES_256_GCM_SHA384".into())),
            raw: Arc::new(b"Subject: hi\r\n\r\nbody\r\n".to_vec()),
        }
    }

    /// Answers one request with `body` after `delay`, and returns what it was sent.
    async fn stub(
        status: u16,
        body: &'static str,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(pos) = text.find("\r\n\r\n") {
                    let length = text[..pos]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= pos + 4 + length || n == 0 {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            tokio::time::sleep(delay).await;
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(reply.as_bytes()).await;
            String::from_utf8_lossy(&buf).to_string()
        });
        (url, handle)
    }

    const ANSWER: &str = r#"{"is_skipped":false,"score":7.456,"required_score":15,"action":"add header",
        "symbols":{"GTUBE":{"name":"GTUBE","score":0},"R_DKIM_NA":{"name":"R_DKIM_NA","score":0.1},
        "MISSING_DATE":{"name":"MISSING_DATE","score":1.0,"options":["a","b","c","d"]},
        "BAYES_HAM":{"name":"BAYES_HAM","score":-3.0},"SUBJ_ALL_CAPS":{"name":"SUBJ_ALL_CAPS","score":3.0}}}"#;

    #[tokio::test]
    async fn sends_the_message_with_rspamds_headers_and_keeps_a_summary() {
        let (url, seen) = stub(200, ANSWER, Duration::ZERO).await;
        let checker = SpamChecker::new(&url, Duration::from_secs(2), 2);
        let verdict = checker.check(request()).await;
        assert_eq!(verdict["score"], json!(7.46));
        assert_eq!(verdict["required"], json!(15.0));
        assert_eq!(verdict["action"], json!("add header"));
        let names: Vec<&str> = verdict["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        // By weight either way, then by name.
        assert_eq!(
            names,
            [
                "BAYES_HAM",
                "SUBJ_ALL_CAPS",
                "MISSING_DATE",
                "R_DKIM_NA",
                "GTUBE"
            ]
        );
        assert_eq!(verdict["symbols"][2]["options"], json!(["a", "b", "c"]));

        let sent = seen.await.unwrap().to_ascii_lowercase();
        assert!(sent.starts_with("post /checkv2 "));
        for header in [
            "ip: 203.0.113.9",
            "helo: mail.example.com",
            "from: sender@example.com",
            "rcpt: abc+tag@mailhooks.cc",
            "rcpt: def@mailhooks.cc",
            "hostname: mail.example.com",
            "queue-id: q1",
            "tls-version: tlsv1_3",
        ] {
            assert!(sent.contains(header), "missing {header}");
        }
        assert!(sent.ends_with("subject: hi\r\n\r\nbody\r\n"));
    }

    #[tokio::test]
    async fn records_why_there_is_no_score() {
        let (url, _) = stub(500, "{}", Duration::ZERO).await;
        let checker = SpamChecker::new(&url, Duration::from_secs(2), 2);
        assert_eq!(
            checker.check(request()).await,
            json!({ "error": "unavailable" })
        );

        let (url, _) = stub(200, "not json", Duration::ZERO).await;
        let checker = SpamChecker::new(&url, Duration::from_secs(2), 2);
        assert_eq!(
            checker.check(request()).await,
            json!({ "error": "invalid" })
        );

        let (url, _) = stub(200, ANSWER, Duration::from_millis(500)).await;
        let checker = SpamChecker::new(&url, Duration::from_millis(100), 2);
        assert_eq!(
            checker.check(request()).await,
            json!({ "error": "timeout" })
        );

        let checker = SpamChecker::new("http://127.0.0.1:9", Duration::from_secs(1), 2);
        assert_eq!(
            checker.check(request()).await,
            json!({ "error": "unavailable" })
        );
    }

    #[tokio::test]
    async fn a_full_house_says_busy() {
        let checker = SpamChecker::new("http://127.0.0.1:9", Duration::from_secs(1), 1);
        let _held = checker.slots.clone().try_acquire_owned().unwrap();
        assert_eq!(checker.check(request()).await, json!({ "error": "busy" }));
    }

    #[test]
    fn summary_is_bounded_and_rejects_foreign_answers() {
        assert_eq!(
            summarize(&json!({ "is_skipped": true })),
            json!({ "error": "skipped" })
        );
        // GTUBE: the scan stops early, but with a verdict.
        let gtube = summarize(&json!({
            "is_skipped": true, "score": 15, "required_score": 15, "action": "reject",
            "passthrough_module": "GTUBE"
        }));
        assert_eq!(gtube["action"], json!("reject"));
        assert_eq!(gtube["score"], json!(15.0));
        assert_eq!(
            gtube["symbols"],
            json!([{ "name": "GTUBE", "score": 15.0 }])
        );
        assert_eq!(
            summarize(&json!({ "score": 1 })),
            json!({ "error": "invalid" })
        );
        let many: Map<String, Value> = (0..50)
            .map(|i| {
                (
                    format!("S{i}"),
                    json!({ "name": "x".repeat(500), "score": i }),
                )
            })
            .collect();
        let verdict = summarize(&json!({
            "score": 1, "required_score": 15, "action": "no action", "symbols": many
        }));
        let symbols = verdict["symbols"].as_array().unwrap();
        assert_eq!(symbols.len(), MAX_SYMBOLS);
        assert_eq!(symbols[0]["score"], json!(49.0));
        assert_eq!(symbols[0]["name"].as_str().unwrap().len(), MAX_NAME_CHARS);

        // Twenty rules with three long multibyte options each: the options go,
        // the verdict and the rules stay, and the receiver's limit holds.
        let heavy: Map<String, Value> = (0..20)
            .map(|i| {
                (
                    format!("R{i}"),
                    json!({ "name": format!("R{i}_{}", "Ä".repeat(90)), "score": i,
                            "options": ["\"😀\"".repeat(80), "é".repeat(200), "\\".repeat(200)] }),
                )
            })
            .collect();
        let verdict = summarize(&json!({
            "score": 20, "required_score": 15, "action": "reject", "symbols": heavy
        }));
        assert!(size(&verdict) <= MAX_SUMMARY_BYTES);
        assert_eq!(verdict["action"], json!("reject"));
        assert_eq!(verdict["symbols"][0]["score"], json!(19.0));
        assert!(verdict["symbols"][0].get("options").is_none());
    }
}
