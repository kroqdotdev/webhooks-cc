//! AES-256-GCM encryption and decryption for signing secrets.
//!
//! Storage format: `[12-byte nonce][ciphertext][16-byte auth tag]`
//! Stored as BYTEA in Postgres. Nonce generated randomly per encryption.

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce};

/// AES-256-GCM nonce size (96 bits).
const NONCE_SIZE: usize = 12;
/// AES-256-GCM authentication tag size (128 bits).
const TAG_SIZE: usize = 16;
/// Minimum ciphertext length: nonce + at least 1 byte + tag.
const MIN_CIPHERTEXT_LEN: usize = NONCE_SIZE + 1 + TAG_SIZE;

#[derive(Debug)]
pub enum CryptoError {
    /// Ciphertext too short to contain nonce + tag.
    TooShort,
    /// Decryption or authentication failed (wrong key, tampered data, etc.).
    DecryptionFailed,
    /// Base64 decoding failed.
    Base64DecodeFailed,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooShort => write!(f, "ciphertext too short"),
            Self::DecryptionFailed => write!(f, "decryption failed"),
            Self::Base64DecodeFailed => write!(f, "base64 decode failed"),
        }
    }
}

/// Decrypt an AES-256-GCM encrypted signing secret.
///
/// `encrypted` is the raw bytes: `[12-byte nonce][ciphertext][16-byte tag]`.
/// `key` is the 32-byte AES-256 key (from `SIGNING_SECRET_KEY` env var).
///
/// Returns the decrypted plaintext bytes.
pub fn decrypt_secret(encrypted: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
    if encrypted.len() < MIN_CIPHERTEXT_LEN {
        return Err(CryptoError::TooShort);
    }

    let nonce_bytes = &encrypted[..NONCE_SIZE];
    let ciphertext_and_tag = &encrypted[NONCE_SIZE..];

    let cipher = Aes256Gcm::new_from_slice(key).expect("key is always 32 bytes");
    let nonce = Nonce::<Aes256Gcm>::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext_and_tag)
        .map_err(|_| CryptoError::DecryptionFailed)
}

/// Decrypt a base64-encoded encrypted signing secret.
///
/// This is used when the encrypted secret comes from the capture_webhook()
/// stored procedure which returns it as base64 text.
pub fn decrypt_secret_b64(encoded: &str, key: &[u8; 32]) -> Result<Vec<u8>, CryptoError> {
    use base64::Engine;
    // SQL encode(..., 'base64') inserts newlines every 76 chars — strip whitespace before decoding
    let cleaned: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|_| CryptoError::Base64DecodeFailed)?;
    decrypt_secret(&encrypted, key)
}

/// Parse a base64-encoded 32-byte key (from env var).
///
/// Returns `None` if the value is not valid base64 or not exactly 32 bytes.
pub fn parse_signing_key(b64: &str) -> Option<[u8; 32]> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    bytes.try_into().ok()
}

#[cfg(test)]
#[path = "tests/crypto_tests.rs"]
mod tests;
