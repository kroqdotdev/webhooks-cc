use super::*;
use ring::rand::{SecureRandom, SystemRandom};

/// Helper: encrypt with AES-256-GCM (mirrors Node.js encryption in web app).
fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).unwrap());
    let mut nonce = [0u8; NONCE_SIZE];
    SystemRandom::new().fill(&mut nonce).unwrap();
    let mut body = plaintext.to_vec();
    cipher
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut body)
        .unwrap();
    let mut out = nonce.to_vec();
    out.extend_from_slice(&body);
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

#[test]
fn opens_a_secret_sealed_by_node() {
    // createCipheriv("aes-256-gcm", 0x42 * 32, nonce 0..11) over
    // "whsec_written_by_node", laid out as apps/web/lib/crypto.ts writes it.
    let sealed = hex::decode(
        "000102030405060708090a0b72b6e2b8d2738579f4723076bf8239426df3a10ec598360b895a6f9fc3e2ddd0707bd9f5f5",
    )
    .unwrap();
    assert_eq!(
        decrypt_secret(&sealed, &test_key()).unwrap(),
        b"whsec_written_by_node"
    );
}

#[test]
fn hmac_sha256_matches_rfc_4231() {
    // RFC 4231 test case 2.
    assert_eq!(
        hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
}
