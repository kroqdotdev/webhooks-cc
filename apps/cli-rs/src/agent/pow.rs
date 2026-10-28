//! Proof of work for anonymous agent registration (scheme
//! `sha256-zero-bits`, see `/auth.md`): for each sub-puzzle `i` in
//! `0..count`, find a decimal nonce such that SHA-256 of the UTF-8 string
//! `<challenge>.<i>.<nonce>` starts with `difficulty` zero bits.
//!
//! The prefix `<challenge>.<i>.` is hashed once per sub-puzzle and the
//! hasher cloned for each nonce, so an attempt only hashes the last block or
//! two. Like the TypeScript SDK, the solver refuses more expected work than
//! 2^26 hashes, so a hostile or broken server cannot pin the CPU.

use anyhow::{Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Expected work above this many hashes (2^26) is refused.
pub const MAX_POW_WORK_BITS: u32 = 26;
pub const POW_ALGORITHM: &str = "sha256-zero-bits";
/// The server accepts nonces of at most this many digits.
const MAX_NONCE_DIGITS: usize = 16;

/// A challenge from `/api/agent/identity/challenge`, or from the body of a
/// refused registration.
#[derive(Debug, Clone)]
pub struct PowChallenge {
    pub challenge: String,
    pub difficulty: u32,
    pub count: u32,
}

impl PowChallenge {
    /// Reads and checks a challenge before any CPU is spent on it.
    pub fn from_json(body: &Value) -> Result<Self> {
        let Some(challenge) = body.get("challenge").and_then(Value::as_str) else {
            bail!("malformed proof-of-work challenge: no challenge");
        };
        let algorithm = body
            .get("algorithm")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if algorithm != POW_ALGORITHM {
            bail!("unsupported proof-of-work algorithm: {algorithm}");
        }
        let integer = |key: &str| {
            body.get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.fract() == 0.0)
        };
        let (Some(difficulty), Some(count)) = (integer("difficulty"), integer("count")) else {
            bail!("invalid proof-of-work parameters");
        };
        if !(0.0..=32.0).contains(&difficulty) || !(1.0..=64.0).contains(&count) {
            bail!("invalid proof-of-work parameters");
        }
        if difficulty + count.log2() > f64::from(MAX_POW_WORK_BITS) {
            bail!(
                "refusing proof of work above 2^{MAX_POW_WORK_BITS} hashes (difficulty {difficulty} x {count})"
            );
        }
        Ok(Self {
            challenge: challenge.to_string(),
            difficulty: difficulty as u32,
            count: count as u32,
        })
    }

    /// One nonce per sub-puzzle. CPU-bound: run it off the async runtime.
    pub fn solve(&self) -> Vec<String> {
        (0..self.count)
            .map(|index| solve_one(&self.challenge, index, self.difficulty).to_string())
            .collect()
    }
}

/// True when the digest starts with `bits` zero bits.
fn leading_zero_bits(digest: &[u8], bits: u32) -> bool {
    let full = (bits / 8) as usize;
    if digest[..full].iter().any(|byte| *byte != 0) {
        return false;
    }
    let rest = bits % 8;
    rest == 0 || digest[full] >> (8 - rest) == 0
}

/// Writes `n` in decimal into `buf` and returns the digits.
fn decimal(mut n: u64, buf: &mut [u8; 20]) -> &[u8] {
    let mut start = buf.len();
    loop {
        start -= 1;
        buf[start] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return &buf[start..];
        }
    }
}

/// The first nonce that solves sub-puzzle `index`.
pub fn solve_one(challenge: &str, index: u32, difficulty: u32) -> u64 {
    let mut prefix = Sha256::new();
    prefix.update(format!("{challenge}.{index}.").as_bytes());
    let mut buf = [0u8; 20];
    // Expected work is 2^difficulty <= 2^32 attempts, far below the
    // 16-digit ceiling, so the loop always ends well before it.
    (0u64..)
        .find(|nonce| {
            let mut hasher = prefix.clone();
            hasher.update(decimal(*nonce, &mut buf));
            leading_zero_bits(&hasher.finalize(), difficulty)
        })
        .unwrap_or_default()
}

/// Checks a solution the way the server does: one decimal nonce of at most
/// 16 digits per sub-puzzle, each hashing to `difficulty` zero bits.
pub fn verify(challenge: &str, difficulty: u32, count: u32, nonces: &[String]) -> bool {
    nonces.len() == count as usize
        && nonces.iter().enumerate().all(|(index, nonce)| {
            !nonce.is_empty()
                && nonce.len() <= MAX_NONCE_DIGITS
                && nonce.bytes().all(|b| b.is_ascii_digit())
                && leading_zero_bits(
                    &Sha256::digest(format!("{challenge}.{index}.{nonce}").as_bytes()),
                    difficulty,
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VECTORS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/web/lib/agent/pow-vectors.json"
    );

    #[test]
    fn solves_the_server_vectors_with_the_same_nonces() {
        let text = std::fs::read_to_string(VECTORS).expect("pow vectors");
        let vectors: Value = serde_json::from_str(&text).unwrap();
        for case in vectors["vectors"].as_array().unwrap() {
            let challenge = PowChallenge::from_json(&json!({
                "challenge": case["challenge"],
                "algorithm": POW_ALGORITHM,
                "difficulty": case["difficulty"],
                "count": case["count"],
            }))
            .unwrap();
            let expected: Vec<String> = serde_json::from_value(case["nonces"].clone()).unwrap();
            let nonces = challenge.solve();
            assert_eq!(nonces, expected, "difficulty {}", challenge.difficulty);
            assert!(verify(
                &challenge.challenge,
                challenge.difficulty,
                challenge.count,
                &nonces
            ));
        }
    }

    #[test]
    fn the_checker_refuses_wrong_solutions() {
        let (challenge, difficulty) = ("pow1.test", 8);
        let nonces = PowChallenge {
            challenge: challenge.into(),
            difficulty,
            count: 2,
        }
        .solve();
        assert!(verify(challenge, difficulty, 2, &nonces));
        assert!(!verify(challenge, difficulty, 3, &nonces), "too few nonces");
        assert!(
            !verify("pow1.other", difficulty, 2, &nonces),
            "another challenge"
        );
        let swapped = vec![nonces[1].clone(), nonces[0].clone()];
        assert!(nonces[0] == nonces[1] || !verify(challenge, difficulty, 2, &swapped));
        let padded = vec![format!("+{}", nonces[0]), nonces[1].clone()];
        assert!(!verify(challenge, difficulty, 2, &padded), "not decimal");
        let long = vec!["1".repeat(17), nonces[1].clone()];
        assert!(!verify(challenge, difficulty, 2, &long), "too many digits");
    }

    #[test]
    fn counts_leading_zero_bits() {
        assert!(leading_zero_bits(&[0x00, 0x0f, 0xff], 12));
        assert!(!leading_zero_bits(&[0x00, 0x1f, 0xff], 12));
        assert!(leading_zero_bits(&[0x00, 0x00, 0xff], 16));
        assert!(leading_zero_bits(&[0xff], 0));
        let mut buf = [0u8; 20];
        assert_eq!(decimal(0, &mut buf), b"0");
        assert_eq!(decimal(9_876_543_210, &mut buf), b"9876543210");
    }

    #[test]
    fn refuses_challenges_before_solving_them() {
        let base = |difficulty: Value, count: Value, algorithm: &str| {
            PowChallenge::from_json(&json!({
                "challenge": "pow1.x",
                "algorithm": algorithm,
                "difficulty": difficulty,
                "count": count,
            }))
        };
        assert!(
            base(json!(18), json!(32), POW_ALGORITHM).is_ok(),
            "2^23 is fine"
        );
        assert!(
            base(json!(21), json!(32), POW_ALGORITHM).is_ok(),
            "2^26 is the ceiling"
        );
        let too_much = base(json!(22), json!(32), POW_ALGORITHM).unwrap_err();
        assert!(too_much.to_string().contains("2^26"));
        assert!(base(json!(18), json!(32), "md5-zero-bits").is_err());
        assert!(base(json!(18.5), json!(32), POW_ALGORITHM).is_err());
        assert!(base(json!(-1), json!(32), POW_ALGORITHM).is_err());
        assert!(base(json!(4), json!(0), POW_ALGORITHM).is_err());
        assert!(base(json!(4), json!(65), POW_ALGORITHM).is_err());
        assert!(base(json!("4"), json!(2), POW_ALGORITHM).is_err());
    }
}
