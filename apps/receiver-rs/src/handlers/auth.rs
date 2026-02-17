use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Constant-time comparison of auth tokens using SHA-256 digests.
/// This avoids timing leaks from length differences and uses a
/// cryptographic hash (not DefaultHasher) for proper security.
pub fn verify_bearer_token(provided: &str, expected_secret: &str) -> bool {
    let expected = format!("Bearer {expected_secret}");
    let provided_digest = Sha256::digest(provided.as_bytes());
    let expected_digest = Sha256::digest(expected.as_bytes());
    provided_digest.ct_eq(&expected_digest).into()
}
