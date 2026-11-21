//! S3-compatible object storage for captured email: the raw message and each
//! attachment, stored under `m/{request_id}/` before the capture is recorded.
//!
//! Only PUT and DELETE are needed here (the web app reads, presigns and
//! deletes in bulk), so this signs requests itself with AWS Signature V4
//! rather than pulling in an SDK. Path-style URLs (`{endpoint}/{bucket}/{key}`)
//! work with every S3-compatible service, Hetzner's included.

use std::time::Duration;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::crypto::hmac_sha256 as hmac;

/// How long one attempt at an upload or delete may take, body included.
/// Messages are at most 10 MB and the bucket sits in the same data centre, so
/// a healthy upload takes a second or two; an attempt that runs this long has
/// stalled.
#[cfg(not(test))]
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(1);

/// How long opening a connection may take, within the attempt.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Uploads are tried twice: a single stalled or refused connection otherwise
/// sends the message back to the sender for a retry minutes later. The MX
/// host waits up to two minutes for a delivery, which covers both attempts,
/// the pause and a cleanup delete after a failure (the mail handler stops
/// storing a message's further copies once one has failed). Deletes are tried
/// once, since the bucket's lifecycle rule removes whatever one leaves behind.
const PUT_ATTEMPTS: u32 = 2;

#[cfg(not(test))]
const RETRY_PAUSE: Duration = Duration::from_millis(500);
#[cfg(test)]
const RETRY_PAUSE: Duration = Duration::from_millis(10);

#[derive(Clone)]
pub struct ObjectStoreConfig {
    /// Base URL without a trailing slash, e.g. `https://fsn1.your-objectstorage.com`.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl std::fmt::Debug for ObjectStoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ObjectStoreConfig")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug)]
pub enum StoreError {
    Http(reqwest::Error),
    Status(u16),
    InvalidEndpoint,
}

impl StoreError {
    /// Whether another attempt may succeed: anything that went wrong on the
    /// way (a refused or reset connection, a timeout), a 5xx or a 429. PUT and
    /// DELETE are idempotent, so trying again is safe.
    fn is_retryable(&self) -> bool {
        match self {
            StoreError::Http(_) => true,
            StoreError::Status(status) => *status >= 500 || *status == 429,
            StoreError::InvalidEndpoint => false,
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // reqwest's message names the URL, which holds no secret, but not
            // why it failed ("error sending request for url (...)"): the cause
            // (a timeout, a refused connection, a reset) is in its source
            // chain, which names no secret either.
            StoreError::Http(e) => {
                let kind = if e.is_timeout() {
                    " (timed out)"
                } else if e.is_connect() {
                    " (connecting failed)"
                } else {
                    ""
                };
                write!(f, "object storage request failed{kind}: {e}")?;
                let mut source = std::error::Error::source(e);
                while let Some(cause) = source {
                    write!(f, ": {cause}")?;
                    source = cause.source();
                }
                Ok(())
            }
            StoreError::Status(status) => write!(f, "object storage answered {status}"),
            StoreError::InvalidEndpoint => write!(f, "object storage endpoint is not a valid URL"),
        }
    }
}

pub struct ObjectStore {
    config: ObjectStoreConfig,
    client: reqwest::Client,
}

impl ObjectStore {
    pub fn new(config: ObjectStoreConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(ATTEMPT_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build the object storage HTTP client");
        Self { config, client }
    }

    pub async fn put(&self, key: &str, body: Bytes, content_type: &str) -> Result<(), StoreError> {
        let payload_hash = hex::encode(Sha256::digest(&body));
        let mut attempt = 1;
        loop {
            match self
                .put_once(key, body.clone(), content_type, &payload_hash)
                .await
            {
                Err(e) if attempt < PUT_ATTEMPTS && e.is_retryable() => {
                    // A message and each attachment retry on their own, so an
                    // outage would print one line per object: one a minute.
                    if retry_log_throttle()
                        .check("put", std::time::Instant::now())
                        .is_some()
                    {
                        tracing::warn!(error = %e, "an object storage upload failed; trying again");
                    }
                    attempt += 1;
                    tokio::time::sleep(RETRY_PAUSE).await;
                }
                outcome => return outcome,
            }
        }
    }

    async fn put_once(
        &self,
        key: &str,
        body: Bytes,
        content_type: &str,
        payload_hash: &str,
    ) -> Result<(), StoreError> {
        // Signed per attempt, so a retry carries a fresh date.
        let (url, headers) = self.signed("PUT", key, payload_hash, Utc::now())?;
        let mut request = self
            .client
            .put(url)
            .header("content-type", content_type)
            .body(body);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(StoreError::Http)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(StoreError::Status(response.status().as_u16()))
        }
    }

    pub async fn delete(&self, key: &str) -> Result<(), StoreError> {
        let payload_hash = hex::encode(Sha256::digest(b""));
        let (url, headers) = self.signed("DELETE", key, &payload_hash, Utc::now())?;
        let mut request = self.client.delete(url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(StoreError::Http)?;
        // S3 answers 204 for a delete, also when the key did not exist.
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(StoreError::Status(response.status().as_u16()))
        }
    }

    /// The request URL and the headers to send with it.
    fn signed(
        &self,
        method: &str,
        key: &str,
        payload_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<SignedRequest, StoreError> {
        let base =
            url::Url::parse(&self.config.endpoint).map_err(|_| StoreError::InvalidEndpoint)?;
        let host = match (base.host_str(), base.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            (None, _) => return Err(StoreError::InvalidEndpoint),
        };
        let base_path = base.path().trim_end_matches('/');
        let path = format!(
            "{base_path}/{}/{}",
            uri_encode(&self.config.bucket, false),
            uri_encode(key, true)
        );
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let authorization = authorization(
            &SigningInput {
                method,
                host: &host,
                path: &path,
                query: "",
                extra_headers: &[],
                payload_hash,
                amz_date: &amz_date,
            },
            &self.config.region,
            &self.config.access_key_id,
            &self.config.secret_access_key,
        );
        let url = format!("{}://{host}{path}", base.scheme());
        Ok((
            url,
            vec![
                ("x-amz-date", amz_date),
                ("x-amz-content-sha256", payload_hash.to_string()),
                ("authorization", authorization),
            ],
        ))
    }
}

fn retry_log_throttle() -> &'static crate::handlers::log_throttle::LogThrottle {
    static THROTTLE: std::sync::OnceLock<crate::handlers::log_throttle::LogThrottle> =
        std::sync::OnceLock::new();
    THROTTLE
        .get_or_init(|| crate::handlers::log_throttle::LogThrottle::new(Duration::from_secs(60), 1))
}

/// A request URL and the headers to send with it.
type SignedRequest = (String, Vec<(&'static str, String)>);

struct SigningInput<'a> {
    method: &'a str,
    host: &'a str,
    /// Already URI-encoded.
    path: &'a str,
    /// Canonical query string (sorted, encoded); empty for none.
    query: &'a str,
    /// Lowercase names, sorted, besides host and the x-amz ones.
    extra_headers: &'a [(&'a str, &'a str)],
    payload_hash: &'a str,
    amz_date: &'a str,
}

/// The `Authorization` header value for AWS Signature V4 (service s3).
fn authorization(input: &SigningInput<'_>, region: &str, access_key: &str, secret: &str) -> String {
    let mut headers: Vec<(&str, &str)> = vec![
        ("host", input.host),
        ("x-amz-content-sha256", input.payload_hash),
        ("x-amz-date", input.amz_date),
    ];
    headers.extend_from_slice(input.extra_headers);
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        input.method,
        input.path,
        input.query,
        canonical_headers,
        signed_headers,
        input.payload_hash
    );
    let date = &input.amz_date[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        input.amz_date,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// RFC 3986 encoding as S3 wants it: unreserved characters stay, everything
/// else is %XX; `/` stays in object keys.
fn uri_encode(input: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Where a captured email's objects live: `m/{request_id}/`.
pub fn request_prefix(request_id: &uuid::Uuid) -> String {
    format!("m/{request_id}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GET Object example from the AWS Signature V4 documentation for S3
    /// ("Example: GET Object"), which pins the whole signing chain.
    #[test]
    fn signs_the_aws_documentation_example() {
        let empty_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let header = authorization(
            &SigningInput {
                method: "GET",
                host: "examplebucket.s3.amazonaws.com",
                path: "/test.txt",
                query: "",
                extra_headers: &[("range", "bytes=0-9")],
                payload_hash: empty_hash,
                amz_date: "20130524T000000Z",
            },
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(
            header,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn encodes_keys_and_keeps_slashes() {
        assert_eq!(uri_encode("m/abc-1/a/0", true), "m/abc-1/a/0");
        assert_eq!(uri_encode("a b+c", true), "a%20b%2Bc");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
    }

    #[test]
    fn builds_path_style_urls_with_the_port() {
        let store = ObjectStore::new(ObjectStoreConfig {
            endpoint: "http://127.0.0.1:8333".into(),
            region: "us-east-1".into(),
            bucket: "mail".into(),
            access_key_id: "id".into(),
            secret_access_key: "secret".into(),
        });
        let (url, headers) = store
            .signed("PUT", "m/x/raw.eml", "hash", Utc::now())
            .unwrap();
        assert_eq!(url, "http://127.0.0.1:8333/mail/m/x/raw.eml");
        assert!(headers.iter().any(|(name, _)| *name == "authorization"));
    }

    fn store_at(endpoint: String) -> ObjectStore {
        ObjectStore::new(ObjectStoreConfig {
            endpoint,
            region: "us-east-1".into(),
            bucket: "mail".into(),
            access_key_id: "id".into(),
            secret_access_key: "secret".into(),
        })
    }

    /// A fake S3 endpoint that answers PUTs with `statuses` in turn (the last
    /// one from then on) and counts them.
    async fn answering(
        statuses: Vec<u16>,
    ) -> (ObjectStore, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let puts = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = puts.clone();
        let app = axum::Router::new().fallback(move || {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            let status = statuses[n.min(statuses.len() - 1)];
            async move { axum::http::StatusCode::from_u16(status).unwrap() }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (store_at(format!("http://{addr}")), puts)
    }

    #[tokio::test]
    async fn an_upload_that_fails_once_is_tried_again() {
        let (store, puts) = answering(vec![503, 200]).await;
        store
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap();
        assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_upload_gives_up_after_two_attempts() {
        let (store, puts) = answering(vec![503]).await;
        let error = store
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "object storage answered 503");
        assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_busy_store_is_tried_again() {
        let (store, puts) = answering(vec![429, 200]).await;
        store
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap();
        assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_stalled_upload_times_out_and_is_tried_again() {
        // The first attempt never gets an answer, the second does.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let puts = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = puts.clone();
        let app = axum::Router::new().fallback(move || {
            let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
            async move {
                if first {
                    std::future::pending::<()>().await;
                }
                axum::http::StatusCode::OK
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        store_at(format!("http://{addr}"))
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap();
        assert_eq!(puts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_store_that_never_answers_names_the_timeout() {
        let app = axum::Router::new().fallback(|| async {
            std::future::pending::<()>().await;
            axum::http::StatusCode::OK
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = store_at(format!("http://{addr}"))
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("object storage request failed (timed out): "),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_refused_upload_is_not_tried_again() {
        // A 4xx (bad credentials, a missing bucket) will not change on a retry.
        let (store, puts) = answering(vec![403]).await;
        assert!(
            store
                .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
                .await
                .is_err()
        );
        assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_connection_failure_names_its_cause() {
        // A reserved port nothing listens on: reqwest alone would only say
        // "error sending request for url (...)".
        let error = store_at("http://127.0.0.1:1".into())
            .put("m/x/raw.eml", Bytes::from_static(b"x"), "message/rfc822")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.starts_with("object storage request failed (connecting failed): "),
            "{error}"
        );
        assert!(error.to_lowercase().contains("refused"), "{error}");
    }

    #[test]
    fn prefixes_are_what_capture_webhook_accepts() {
        let id = uuid::Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        assert_eq!(
            request_prefix(&id),
            "m/11111111-2222-4333-8444-555555555555/"
        );
    }
}
