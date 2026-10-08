//! Request signing for the internal mail API.
//!
//! The MX host signs every request with `CAPTURE_SHARED_SECRET`:
//! `x-mail-signature` is the hex HMAC-SHA256 of `"{timestamp}.{METHOD}.{path}."`
//! followed by the raw body, and `x-mail-timestamp` is the unix time in
//! seconds. The five minute window bounds replays; the listener is only
//! reachable from the private network in the first place.

use axum::http::HeaderMap;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const TIMESTAMP_HEADER: &str = "x-mail-timestamp";
pub const SIGNATURE_HEADER: &str = "x-mail-signature";

/// Largest accepted distance between the signed timestamp and now.
pub const MAX_SKEW_SECS: u64 = 300;

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// The receiver has no shared secret, so nothing can be verified.
    NoSecret,
    Missing,
    BadTimestamp,
    Expired,
    BadSignature,
}

/// Hex HMAC-SHA256 over `"{timestamp}.{method}.{path}."` and the body.
pub fn sign(secret: &[u8], timestamp: i64, method: &str, path: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(format!("{timestamp}.{method}.{path}.").as_bytes());
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// The cheap part of the check, done before the body is read: both headers
/// present and the timestamp fresh. Returns the timestamp and signature.
pub fn precheck(headers: &HeaderMap, now: i64) -> Result<(i64, &str), AuthError> {
    let timestamp = headers
        .get(TIMESTAMP_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or(AuthError::Missing)?;
    let signature = headers
        .get(SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or(AuthError::Missing)?;
    let timestamp: i64 = timestamp
        .trim()
        .parse()
        .map_err(|_| AuthError::BadTimestamp)?;
    if now.abs_diff(timestamp) > MAX_SKEW_SECS {
        return Err(AuthError::Expired);
    }
    Ok((timestamp, signature))
}

/// Check the signature headers against the request. `now` is unix seconds.
pub fn verify(
    secret: &[u8],
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: &[u8],
    now: i64,
) -> Result<(), AuthError> {
    if secret.is_empty() {
        return Err(AuthError::NoSecret);
    }
    let (timestamp, signature) = precheck(headers, now)?;
    let expected = sign(secret, timestamp, method, path, body);
    let provided = signature.trim().to_ascii_lowercase();
    if constant_time_eq::constant_time_eq(expected.as_bytes(), provided.as_bytes()) {
        Ok(())
    } else {
        Err(AuthError::BadSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const SECRET: &[u8] = b"test-secret";
    const NOW: i64 = 1_800_000_000;

    fn signed_headers(timestamp: i64, signature: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            TIMESTAMP_HEADER,
            HeaderValue::from_str(&timestamp.to_string()).unwrap(),
        );
        headers.insert(SIGNATURE_HEADER, HeaderValue::from_str(signature).unwrap());
        headers
    }

    #[test]
    fn accepts_a_valid_signature() {
        let body = br#"{"address":"abc@mailhooks.cc"}"#;
        let sig = sign(SECRET, NOW, "POST", "/internal/mail/check", body);
        let headers = signed_headers(NOW, &sig);
        assert_eq!(
            verify(
                SECRET,
                &headers,
                "POST",
                "/internal/mail/check",
                body,
                NOW + 10
            ),
            Ok(())
        );
    }

    #[test]
    fn accepts_an_uppercase_hex_signature() {
        let sig = sign(SECRET, NOW, "POST", "/p", b"x").to_ascii_uppercase();
        let headers = signed_headers(NOW, &sig);
        assert_eq!(verify(SECRET, &headers, "POST", "/p", b"x", NOW), Ok(()));
    }

    #[test]
    fn rejects_a_changed_body_path_or_method() {
        let sig = sign(SECRET, NOW, "POST", "/a", b"body");
        let headers = signed_headers(NOW, &sig);
        assert_eq!(
            verify(SECRET, &headers, "POST", "/a", b"body2", NOW),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            verify(SECRET, &headers, "POST", "/b", b"body", NOW),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            verify(SECRET, &headers, "GET", "/a", b"body", NOW),
            Err(AuthError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_wrong_secret() {
        let sig = sign(b"other", NOW, "POST", "/a", b"");
        let headers = signed_headers(NOW, &sig);
        assert_eq!(
            verify(SECRET, &headers, "POST", "/a", b"", NOW),
            Err(AuthError::BadSignature)
        );
    }

    #[test]
    fn rejects_stale_and_future_timestamps() {
        let sig = sign(SECRET, NOW, "POST", "/a", b"");
        let headers = signed_headers(NOW, &sig);
        let skew = MAX_SKEW_SECS as i64;
        assert_eq!(
            verify(SECRET, &headers, "POST", "/a", b"", NOW + skew + 1),
            Err(AuthError::Expired)
        );
        assert_eq!(
            verify(SECRET, &headers, "POST", "/a", b"", NOW - skew - 1),
            Err(AuthError::Expired)
        );
    }

    #[test]
    fn extreme_timestamps_are_expired_not_a_panic() {
        for ts in [i64::MIN, i64::MAX] {
            let headers = signed_headers(ts, "00");
            assert_eq!(precheck(&headers, NOW), Err(AuthError::Expired));
        }
    }

    #[test]
    fn precheck_needs_no_body_or_secret() {
        let headers = signed_headers(NOW, "abc");
        assert_eq!(precheck(&headers, NOW), Ok((NOW, "abc")));
        assert_eq!(precheck(&HeaderMap::new(), NOW), Err(AuthError::Missing));
    }

    #[test]
    fn rejects_missing_or_malformed_headers() {
        assert_eq!(
            verify(SECRET, &HeaderMap::new(), "POST", "/a", b"", NOW),
            Err(AuthError::Missing)
        );
        let headers = signed_headers(NOW, "abc");
        let mut bad_ts = headers.clone();
        bad_ts.insert(TIMESTAMP_HEADER, HeaderValue::from_static("soon"));
        assert_eq!(
            verify(SECRET, &bad_ts, "POST", "/a", b"", NOW),
            Err(AuthError::BadTimestamp)
        );
    }

    #[test]
    fn refuses_everything_without_a_secret() {
        let sig = sign(b"", NOW, "POST", "/a", b"");
        let headers = signed_headers(NOW, &sig);
        assert_eq!(
            verify(b"", &headers, "POST", "/a", b"", NOW),
            Err(AuthError::NoSecret)
        );
    }
}
