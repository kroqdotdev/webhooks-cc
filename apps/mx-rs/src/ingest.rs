//! Client for the receiver's private mail API (`apps/receiver-rs/src/mail`).
//!
//! Every request is signed with the shared secret exactly as the receiver
//! verifies it: `x-mail-signature` is the hex HMAC-SHA256 of
//! `"{timestamp}.POST.{path}."` followed by the body.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::expiring::Expiring;
use crate::reply::{CheckStatus, DeliverOutcome};

pub const CHECK_PATH: &str = "/internal/mail/check";
pub const DELIVER_PATH: &str = "/internal/mail/deliver";
/// Most recipient answers kept at once.
const CACHE_CAP: usize = 50_000;

/// The receiver's syntax rule for the local part (`parse_recipient` in
/// `apps/receiver-rs/src/mail/address.rs`; keep the two in step): 1 to 64
/// printable ASCII characters without specials. The slug and the domain are
/// part of the cache key, so they need no check here.
fn plausible_local_part(address: &str) -> bool {
    let address = address.trim();
    let address = address
        .strip_prefix('<')
        .and_then(|a| a.strip_suffix('>'))
        .unwrap_or(address);
    let Some((local, _)) = address.rsplit_once('@') else {
        return false;
    };
    (1..=64).contains(&local.len())
        && local
            .bytes()
            .all(|b| b.is_ascii_graphic() && !b"\"\\<>@(),;:[]".contains(&b))
}

pub fn sign(secret: &[u8], timestamp: i64, method: &str, path: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(format!("{timestamp}.{method}.{path}.").as_bytes());
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Everything the receiver needs to capture one accepted message.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub recipients: Vec<String>,
    pub envelope_from: String,
    pub client_ip: String,
    pub client_rdns: Option<String>,
    pub helo: Option<String>,
    pub tls: Option<serde_json::Value>,
    pub auth: serde_json::Value,
    pub received_at: chrono::DateTime<chrono::Utc>,
    /// The same bytes were handed over before without a definitive answer
    /// reaching the sender, so the receiver may already hold them.
    pub retry: bool,
    /// The message exactly as received.
    pub raw: Arc<Vec<u8>>,
}

#[derive(Serialize)]
struct DeliverBody<'a> {
    recipients: &'a [String],
    envelope_from: &'a str,
    client_ip: &'a str,
    client_rdns: Option<&'a str>,
    helo: Option<&'a str>,
    tls: Option<&'a serde_json::Value>,
    auth: &'a serde_json::Value,
    received_at: String,
    retry: bool,
    raw: String,
}

#[derive(Deserialize)]
struct CheckAnswer {
    status: String,
}

#[derive(Deserialize)]
struct DeliverAnswer {
    results: Vec<DeliverResult>,
}

#[derive(Deserialize)]
struct DeliverResult {
    status: String,
}

pub struct Ingest {
    client: reqwest::Client,
    base_url: String,
    secret: Vec<u8>,
    check_timeout: Duration,
    deliver_timeout: Duration,
    cache: Mutex<Expiring<String, (CheckStatus, Instant)>>,
}

impl Ingest {
    pub fn new(
        base_url: &str,
        secret: &str,
        check_timeout: Duration,
        deliver_timeout: Duration,
    ) -> Self {
        Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                // Straight to the private network, whatever proxy the
                // environment names.
                .no_proxy()
                .build()
                .expect("reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: secret.as_bytes().to_vec(),
            check_timeout,
            deliver_timeout,
            cache: Mutex::new(Expiring::capped(CACHE_CAP)),
        }
    }

    async fn post(
        &self,
        path: &str,
        body: Vec<u8>,
        timeout: Duration,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let timestamp = chrono::Utc::now().timestamp();
        let signature = sign(&self.secret, timestamp, "POST", path, &body);
        self.client
            .post(format!("{}{path}", self.base_url))
            .timeout(timeout)
            .header("content-type", "application/json")
            .header("x-mail-timestamp", timestamp.to_string())
            .header("x-mail-signature", signature)
            .body(body)
            .send()
            .await
    }

    /// Whether the receiver would take mail for `address` right now. Answers
    /// are cached briefly; errors and "paused" never are. Answers about the
    /// endpoint are cached per slug, so a stream of random `+tags` cannot
    /// bypass the cache; answers about the address itself (invalid syntax,
    /// another domain) per full address.
    pub async fn check(&self, address: &str) -> CheckStatus {
        let full_key = address.trim().to_ascii_lowercase();
        let slug_key = crate::limits::address_key(address);
        let now = Instant::now();
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            // The answer about this exact address wins over the one about
            // its endpoint: `abc+<bad tag>` stays invalid while `abc` is ok.
            // An address the receiver would refuse for its own syntax never
            // borrows the endpoint's answer.
            let keys: &[&str] = if plausible_local_part(address) {
                &[&full_key, &slug_key]
            } else {
                &[&full_key]
            };
            for &key in keys {
                if let Some((status, until)) = cache.get(key)
                    && *until > now
                {
                    return *status;
                }
            }
        }

        let body = serde_json::to_vec(&serde_json::json!({ "address": address.trim() }))
            .expect("serializable");
        let status = match self.post(CHECK_PATH, body, self.check_timeout).await {
            Ok(response) if response.status() == reqwest::StatusCode::OK => {
                match response.json::<CheckAnswer>().await {
                    Ok(answer) => CheckStatus::parse(&answer.status),
                    Err(e) => {
                        tracing::warn!(error = %e, "unreadable recipient check answer");
                        CheckStatus::Error
                    }
                }
            }
            Ok(response) => {
                tracing::warn!(
                    status = response.status().as_u16(),
                    "recipient check refused"
                );
                CheckStatus::Error
            }
            Err(e) => {
                tracing::warn!(error = %e, "recipient check failed");
                CheckStatus::Error
            }
        };

        if let Some(secs) = status.cache_secs() {
            let key = match status {
                CheckStatus::Invalid | CheckStatus::RelayDenied => full_key,
                _ => slug_key,
            };
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.insert(
                key,
                (status, now + Duration::from_secs(secs)),
                |_, (_, until)| *until > now,
            );
        }
        status
    }

    pub async fn deliver(&self, delivery: Delivery) -> DeliverOutcome {
        // Base64 and JSON for a 10 MiB message are tens of milliseconds of CPU:
        // keep them off the async workers.
        let encoded = tokio::task::spawn_blocking(move || {
            serde_json::to_vec(&DeliverBody {
                recipients: &delivery.recipients,
                envelope_from: &delivery.envelope_from,
                client_ip: &delivery.client_ip,
                client_rdns: delivery.client_rdns.as_deref(),
                helo: delivery.helo.as_deref(),
                tls: delivery.tls.as_ref(),
                auth: &delivery.auth,
                received_at: delivery.received_at.to_rfc3339(),
                retry: delivery.retry,
                raw: base64::engine::general_purpose::STANDARD.encode(delivery.raw.as_slice()),
            })
        })
        .await;
        let body = match encoded {
            Ok(Ok(body)) => body,
            Ok(Err(e)) => {
                tracing::error!(error = %e, "could not encode the delivery");
                return DeliverOutcome::Failed;
            }
            Err(e) => {
                tracing::error!(error = %e, "delivery encoding task failed");
                return DeliverOutcome::Failed;
            }
        };
        match self.post(DELIVER_PATH, body, self.deliver_timeout).await {
            Ok(response) if response.status() == reqwest::StatusCode::OK => {
                match response.json::<DeliverAnswer>().await {
                    Ok(answer) => DeliverOutcome::Results(
                        answer.results.into_iter().map(|r| r.status).collect(),
                    ),
                    Err(e) => {
                        tracing::warn!(error = %e, "unreadable delivery answer");
                        DeliverOutcome::Failed
                    }
                }
            }
            Ok(response) => DeliverOutcome::HttpStatus(response.status().as_u16()),
            Err(e) => {
                tracing::warn!(error = %e, "delivery call failed");
                DeliverOutcome::Failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn signs_exactly_like_the_receiver() {
        // Reference value computed independently with Python's hmac module.
        assert_eq!(
            sign(
                b"test-secret",
                1_800_000_000,
                "POST",
                CHECK_PATH,
                br#"{"address":"abc@mailhooks.cc"}"#
            ),
            "4a609ca17931689d182ad6d5e66deddfc95fb0801b9b232c880b30e53ed17a30"
        );
    }

    struct Seen {
        path: String,
        headers: String,
        body: Vec<u8>,
    }

    /// A one-route HTTP stub: answers every request with `status` and `body`
    /// and records what it was sent.
    async fn stub(
        status: u16,
        body: &'static str,
    ) -> (String, Arc<Mutex<Vec<Seen>>>, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (seen2, hits2) = (seen.clone(), hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen2.clone();
                let hits = hits2.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 65536];
                    let (head_end, content_length) = loop {
                        let n = socket.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .map(|v| v.trim().parse::<usize>().unwrap())
                                .unwrap_or(0);
                            break (pos + 4, len);
                        }
                    };
                    while buf.len() < head_end + content_length {
                        let n = socket.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    seen.lock().unwrap().push(Seen {
                        path,
                        headers: head,
                        body: buf[head_end..head_end + content_length].to_vec(),
                    });
                    hits.fetch_add(1, Ordering::SeqCst);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        (url, seen, hits)
    }

    fn ingest(url: &str) -> Ingest {
        Ingest::new(
            url,
            "secret",
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
    }

    #[tokio::test]
    async fn check_signs_the_request_and_caches_the_answer() {
        let (url, seen, hits) = stub(200, r#"{"status":"ok","endpoint_id":"e1"}"#).await;
        let client = ingest(&url);
        assert_eq!(client.check("Abc@mailhooks.cc").await, CheckStatus::Ok);
        assert_eq!(client.check("abc@MAILHOOKS.cc").await, CheckStatus::Ok);
        assert_eq!(
            client.check("abc+random1@mailhooks.cc").await,
            CheckStatus::Ok
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "later answers, other tags included, came from the cache"
        );

        let seen = seen.lock().unwrap();
        let request = &seen[0];
        assert_eq!(request.path, CHECK_PATH);
        let header = |name: &str| {
            request
                .headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix(&format!("{name}: "))
                        .map(str::to_string)
                })
                .unwrap()
        };
        let ts: i64 = header("x-mail-timestamp").parse().unwrap();
        assert_eq!(
            header("x-mail-signature"),
            sign(b"secret", ts, "POST", CHECK_PATH, &request.body)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
            serde_json::json!({"address": "Abc@mailhooks.cc"})
        );
    }

    #[tokio::test]
    async fn check_prefers_the_cached_answer_about_the_exact_address() {
        let (url, _, hits) = stub(200, r#"{"status":"invalid"}"#).await;
        let client = ingest(&url);
        let bad = "abc+bad\"tag@mailhooks.cc";
        assert_eq!(client.check(bad).await, CheckStatus::Invalid);
        client.cache.lock().unwrap().insert(
            crate::limits::address_key("abc@mailhooks.cc"),
            (CheckStatus::Ok, Instant::now() + Duration::from_secs(60)),
            |_, _| true,
        );
        assert_eq!(client.check(bad).await, CheckStatus::Invalid);
        assert_eq!(client.check("abc@mailhooks.cc").await, CheckStatus::Ok);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_address_with_a_malformed_tag_never_borrows_the_endpoints_answer() {
        let (url, _, hits) = stub(200, r#"{"status":"invalid"}"#).await;
        let client = ingest(&url);
        client.cache.lock().unwrap().insert(
            crate::limits::address_key("abc@mailhooks.cc"),
            (CheckStatus::Ok, Instant::now() + Duration::from_secs(60)),
            |_, _| true,
        );
        assert_eq!(client.check("abc+fine@mailhooks.cc").await, CheckStatus::Ok);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        for odd in [
            "abc+caf\u{e9}@mailhooks.cc",
            "abc+a(b)@mailhooks.cc",
            &format!("abc+{}@mailhooks.cc", "t".repeat(64)),
        ] {
            assert_eq!(client.check(odd).await, CheckStatus::Invalid, "{odd}");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 3, "each went to the receiver");
    }

    #[test]
    fn checks_local_parts_like_the_receiver() {
        for ok in [
            "abc@mailhooks.cc",
            "<abc+Signup.Flow@mailhooks.cc>",
            "a+b+c@x",
        ] {
            assert!(plausible_local_part(ok), "{ok}");
        }
        for bad in [
            "abc",
            "@mailhooks.cc",
            "\"quoted\"@mailhooks.cc",
            "a b@mailhooks.cc",
            "abc+\u{e9}@mailhooks.cc",
        ] {
            assert!(!plausible_local_part(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn check_does_not_cache_errors_or_pauses() {
        let (url, _, hits) = stub(200, r#"{"status":"paused"}"#).await;
        let client = ingest(&url);
        assert_eq!(client.check("a@mailhooks.cc").await, CheckStatus::Paused);
        assert_eq!(client.check("a@mailhooks.cc").await, CheckStatus::Paused);
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        let (url, _, _) = stub(503, "retry").await;
        assert_eq!(
            ingest(&url).check("a@mailhooks.cc").await,
            CheckStatus::Error
        );
        assert_eq!(
            ingest("http://127.0.0.1:1").check("a@mailhooks.cc").await,
            CheckStatus::Error
        );
    }

    fn delivery() -> Delivery {
        Delivery {
            recipients: vec!["a@mailhooks.cc".into()],
            envelope_from: "s@example.com".into(),
            client_ip: "192.0.2.1".into(),
            client_rdns: Some("mail.example.com".into()),
            helo: Some("mail.example.com".into()),
            tls: None,
            auth: serde_json::json!({"spf": "pass"}),
            received_at: chrono::Utc::now(),
            retry: true,
            raw: Arc::new(b"Subject: x\r\n\r\nbody\r\n".to_vec()),
        }
    }

    #[tokio::test]
    async fn deliver_sends_the_message_and_reads_the_results() {
        let (url, seen, _) = stub(
            200,
            r#"{"results":[{"recipient":"a@mailhooks.cc","status":"captured","request_id":"r1"}]}"#,
        )
        .await;
        let outcome = ingest(&url).deliver(delivery()).await;
        assert_eq!(outcome, DeliverOutcome::Results(vec!["captured".into()]));

        let seen = seen.lock().unwrap();
        let body: serde_json::Value = serde_json::from_slice(&seen[0].body).unwrap();
        assert_eq!(seen[0].path, DELIVER_PATH);
        assert_eq!(body["retry"], true);
        assert_eq!(body["recipients"], serde_json::json!(["a@mailhooks.cc"]));
        let raw = base64::engine::general_purpose::STANDARD
            .decode(body["raw"].as_str().unwrap())
            .unwrap();
        assert_eq!(raw, b"Subject: x\r\n\r\nbody\r\n");
    }

    #[tokio::test]
    async fn deliver_reports_http_errors_and_failed_calls() {
        let (url, _, _) = stub(413, "too large").await;
        assert_eq!(
            ingest(&url).deliver(delivery()).await,
            DeliverOutcome::HttpStatus(413)
        );
        let (url, _, _) = stub(200, "not json").await;
        assert_eq!(
            ingest(&url).deliver(delivery()).await,
            DeliverOutcome::Failed
        );
        assert_eq!(
            ingest("http://127.0.0.1:1").deliver(delivery()).await,
            DeliverOutcome::Failed
        );
    }
}
