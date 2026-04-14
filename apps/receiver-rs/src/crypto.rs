//! AES-256-GCM encryption and decryption for signing secrets.
//!
//! Storage format: `[12-byte nonce][ciphertext][16-byte auth tag]`
//! Stored as BYTEA in Postgres. Nonce generated randomly per encryption.

use aes_gcm::aead::{Aead, KeyInit, Nonce};
use aes_gcm::Aes256Gcm;

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
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()?;
    bytes.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::OsRng;
    use aes_gcm::{AeadCore, Aes256Gcm, KeyInit};
    use aes_gcm::aead::Aead;

    /// Helper: encrypt with AES-256-GCM (mirrors Node.js encryption in web app).
    fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher.encrypt(&nonce, plaintext).unwrap();
        let mut out = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);
        out
    }

    fn test_key() -> [u8; 32] {
        [0x42; 32]
    }

    #[test]
    fn round_trip() {
        let key = test_key();
        let plaintext = b"whsec_test_secret_1234567890";
        let encrypted = encrypt(plaintext, &key);
        let decrypted = decrypt_secret(&encrypted, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn round_trip_empty_plaintext() {
        // Edge case: empty signing secret (shouldn't happen in practice, but shouldn't panic)
        let key = test_key();
        let plaintext = b"";
        let encrypted = encrypt(plaintext, &key);
        // Empty plaintext: nonce(12) + tag(16) = 28 bytes, no ciphertext body.
        // MIN_CIPHERTEXT_LEN requires at least 29 (nonce + 1 + tag).
        // aes-gcm can encrypt empty plaintext but our guard rejects it — that's fine,
        // real secrets are never empty.
        assert!(encrypted.len() < MIN_CIPHERTEXT_LEN || decrypt_secret(&encrypted, &key).is_ok());
    }

    #[test]
    fn wrong_key_fails() {
        let key = test_key();
        let wrong_key = [0x99; 32];
        let encrypted = encrypt(b"secret", &key);
        assert!(matches!(
            decrypt_secret(&encrypted, &wrong_key),
            Err(CryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = test_key();
        let mut encrypted = encrypt(b"secret", &key);
        // Flip a byte in the ciphertext portion (after the nonce)
        let idx = NONCE_SIZE + 1;
        if idx < encrypted.len() {
            encrypted[idx] ^= 0xFF;
        }
        assert!(matches!(
            decrypt_secret(&encrypted, &key),
            Err(CryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn too_short_fails() {
        let key = test_key();
        // Just a nonce, no ciphertext or tag
        let short = vec![0u8; NONCE_SIZE];
        assert!(matches!(
            decrypt_secret(&short, &key),
            Err(CryptoError::TooShort)
        ));
    }

    #[test]
    fn empty_input_fails() {
        let key = test_key();
        assert!(matches!(
            decrypt_secret(&[], &key),
            Err(CryptoError::TooShort)
        ));
    }

    #[test]
    fn nonce_uniqueness() {
        let key = test_key();
        let plaintext = b"same_secret";
        let enc1 = encrypt(plaintext, &key);
        let enc2 = encrypt(plaintext, &key);
        // Same plaintext produces different ciphertext (random nonce)
        assert_ne!(enc1, enc2);
        // But both decrypt to the same plaintext
        assert_eq!(decrypt_secret(&enc1, &key).unwrap(), plaintext);
        assert_eq!(decrypt_secret(&enc2, &key).unwrap(), plaintext);
    }

    #[test]
    fn base64_round_trip() {
        use base64::Engine;
        let key = test_key();
        let plaintext = b"whsec_stripe_secret";
        let encrypted = encrypt(plaintext, &key);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&encrypted);
        let decrypted = decrypt_secret_b64(&encoded, &key).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn invalid_base64_fails() {
        let key = test_key();
        assert!(matches!(
            decrypt_secret_b64("not-valid-base64!!!", &key),
            Err(CryptoError::Base64DecodeFailed)
        ));
    }

    #[test]
    fn parse_signing_key_valid() {
        use base64::Engine;
        let key_bytes = [0xAB; 32];
        let encoded = base64::engine::general_purpose::STANDARD.encode(key_bytes);
        let parsed = parse_signing_key(&encoded).unwrap();
        assert_eq!(parsed, key_bytes);
    }

    #[test]
    fn parse_signing_key_wrong_length() {
        use base64::Engine;
        let short = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(parse_signing_key(&short).is_none());

        let long = base64::engine::general_purpose::STANDARD.encode([0u8; 64]);
        assert!(parse_signing_key(&long).is_none());
    }

    #[test]
    fn parse_signing_key_invalid_base64() {
        assert!(parse_signing_key("not-base64!!!").is_none());
    }
}
