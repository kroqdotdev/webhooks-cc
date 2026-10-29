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
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// How long one upload or delete may take. The MX host waits up to two
/// minutes for a delivery, which covers a few of these in a row.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // reqwest's message names the URL, which holds no secret.
            StoreError::Http(e) => write!(f, "object storage request failed: {e}"),
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
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build the object storage HTTP client");
        Self { config, client }
    }

    pub async fn put(&self, key: &str, body: Bytes, content_type: &str) -> Result<(), StoreError> {
        let payload_hash = hex::encode(Sha256::digest(&body));
        let (url, headers) = self.signed("PUT", key, &payload_hash, Utc::now())?;
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

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
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

    #[test]
    fn prefixes_are_what_capture_webhook_accepts() {
        let id = uuid::Uuid::parse_str("11111111-2222-4333-8444-555555555555").unwrap();
        assert_eq!(
            request_prefix(&id),
            "m/11111111-2222-4333-8444-555555555555/"
        );
    }
}
