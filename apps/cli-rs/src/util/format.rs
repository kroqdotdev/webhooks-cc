use chrono::{DateTime, Local, TimeZone, Utc};

/// Format a unix timestamp (ms) as a local time string.
pub fn format_timestamp(ts_ms: i64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ts_ms)
        .single()
        .map(|utc| utc.with_timezone(&Local));
    match dt {
        Some(local) => local.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => "unknown".to_string(),
    }
}

/// Format bytes into human-readable string.
pub fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Decode the RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?UTF-8?Q?...?=`)
/// in a raw header such as an email's subject. UTF-8, US-ASCII and
/// ISO-8859-1 are decoded; a word in another charset, or one that does not
/// decode, is kept as written.
pub fn decode_encoded_words(raw: &str) -> String {
    let mut out = String::new();
    // Bytes of adjacent UTF-8 words, decoded together: a sender may split one
    // character across two words.
    let mut utf8 = Vec::new();
    let mut after_word = false;
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        let Some((word, len)) = decode_word(&rest[start..]) else {
            out.push_str(&String::from_utf8_lossy(&std::mem::take(&mut utf8)));
            out.push_str(&rest[..start + 2]);
            rest = &rest[start + 2..];
            after_word = false;
            continue;
        };
        // Whitespace between two encoded words is not part of the text.
        let between = &rest[..start];
        if !(after_word && between.chars().all(char::is_whitespace)) {
            out.push_str(&String::from_utf8_lossy(&std::mem::take(&mut utf8)));
            out.push_str(between);
        }
        match word {
            Word::Utf8(bytes) => utf8.extend(bytes),
            Word::Text(text) => {
                out.push_str(&String::from_utf8_lossy(&std::mem::take(&mut utf8)));
                out.push_str(&text);
            }
        }
        after_word = true;
        rest = &rest[start + len..];
    }
    out.push_str(&String::from_utf8_lossy(&utf8));
    out.push_str(rest);
    out
}

enum Word {
    Utf8(Vec<u8>),
    Text(String),
}

/// RFC 2047 caps an encoded word at 75 characters, all of them ASCII; some
/// senders run longer, so a little more is read. Bounding the scan keeps
/// decoding linear in the subject even when it is full of `=?` that never
/// close, and bounding it in bytes makes each attempt constant-time.
const MAX_ENCODED_WORD_BYTES: usize = 256;

/// One encoded word at the start of `s` and its length in bytes.
fn decode_word(s: &str) -> Option<(Word, usize)> {
    use base64::Engine;

    let mut end = s.len().min(MAX_ENCODED_WORD_BYTES);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let s = &s[..end];
    let inner = s.strip_prefix("=?")?;
    let (charset, inner) = inner.split_once('?')?;
    let (encoding, inner) = inner.split_once('?')?;
    let text = &inner[..inner.find("?=")?];
    if [charset, encoding, text]
        .iter()
        .any(|part| part.contains(char::is_whitespace))
    {
        return None;
    }
    let len = 2 + charset.len() + 1 + encoding.len() + 1 + text.len() + 2;
    let bytes = match encoding {
        "B" | "b" => base64::engine::general_purpose::STANDARD
            .decode(text)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(text))
            .ok()?,
        "Q" | "q" => {
            let mut bytes = Vec::with_capacity(text.len());
            let mut iter = text.bytes();
            while let Some(b) = iter.next() {
                match b {
                    b'_' => bytes.push(b' '),
                    b'=' => {
                        let hex = [iter.next()?, iter.next()?];
                        bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
                    }
                    b => bytes.push(b),
                }
            }
            bytes
        }
        _ => return None,
    };
    // RFC 2231 lets a language follow the charset: `UTF-8*en`.
    let charset = charset.split('*').next().unwrap_or("").to_ascii_lowercase();
    let word = match charset.as_str() {
        "utf-8" | "utf8" | "us-ascii" => Word::Utf8(bytes),
        "iso-8859-1" | "latin1" => Word::Text(bytes.iter().map(|&b| b as char).collect()),
        _ => return None,
    };
    Some((word, len))
}

/// Format a DateTime as ISO 8601 string, or parse one.
pub fn format_iso(ts_ms: i64) -> String {
    Utc.timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt: DateTime<Utc>| dt.to_rfc3339())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Parse a duration string like "30s", "5m", "1h", "7d" into milliseconds.
pub fn parse_duration(input: &str) -> anyhow::Result<i64> {
    let input = input.trim();
    if input.is_empty() {
        anyhow::bail!("empty duration");
    }
    if let Ok(ms) = input.parse::<i64>() {
        if ms < 0 {
            anyhow::bail!("duration must be positive");
        }
        return Ok(ms);
    }

    let (num_str, unit) = if let Some(prefix) = input.strip_suffix("ms") {
        (prefix, "ms")
    } else {
        // Split at the last char boundary safely
        let mut chars = input.char_indices();
        let (last_idx, last_char) = chars
            .next_back()
            .ok_or_else(|| anyhow::anyhow!("invalid duration: {input}"))?;
        if !last_char.is_ascii_alphabetic() {
            anyhow::bail!("invalid duration unit in: {input}");
        }
        (&input[..last_idx], &input[last_idx..])
    };

    let num: f64 = num_str
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid duration: {input}"))?;

    if !num.is_finite() || num < 0.0 {
        anyhow::bail!("duration must be a positive finite number");
    }

    let ms = match unit {
        "ms" => num,
        "s" => num * 1000.0,
        "m" => num * 60_000.0,
        "h" => num * 3_600_000.0,
        "d" => num * 86_400_000.0,
        _ => anyhow::bail!("unknown duration unit: {unit} (use ms, s, m, h, or d)"),
    };

    if ms < 0.0 {
        anyhow::bail!("duration must be positive");
    }
    Ok(ms as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Decoding stays linear because no attempt looks further than
    // MAX_ENCODED_WORD_BYTES past its `=?`. These check that bound itself,
    // which a wall-clock limit could not do reliably in a debug build.
    #[test]
    fn stops_looking_for_the_end_of_a_word_at_the_cap() {
        let word = |text_len: usize| format!("=?UTF-8?Q?{}?=", "a".repeat(text_len));
        let longest = MAX_ENCODED_WORD_BYTES - "=?UTF-8?Q??=".len();
        assert_eq!(decode_encoded_words(&word(longest)), "a".repeat(longest));
        assert_eq!(decode_encoded_words(&word(longest + 1)), word(longest + 1));
        // A cap that lands inside a character moves back to its start.
        let split = format!("=?a{}", "\u{e9}".repeat(500));
        assert!(!split.is_char_boundary(MAX_ENCODED_WORD_BYTES));
        assert_eq!(decode_encoded_words(&split), split);
    }

    #[test]
    fn decodes_a_long_run_of_unclosed_words() {
        let hostile = "=?a".repeat(200_000);
        assert_eq!(decode_encoded_words(&hostile), hostile);
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1_572_864), "1.5 MB");
    }

    #[test]
    fn test_parse_duration() {
        assert_eq!(parse_duration("500").unwrap(), 500);
        assert_eq!(parse_duration("30s").unwrap(), 30_000);
        assert_eq!(parse_duration("5m").unwrap(), 300_000);
        assert_eq!(parse_duration("1h").unwrap(), 3_600_000);
        assert_eq!(parse_duration("7d").unwrap(), 604_800_000);
        assert_eq!(parse_duration("500ms").unwrap(), 500);
        assert_eq!(parse_duration("1.5s").unwrap(), 1500);
    }

    #[test]
    fn test_parse_duration_rejects_invalid() {
        assert!(parse_duration("").is_err());
        assert!(parse_duration("-5s").is_err());
        assert!(parse_duration("5秒").is_err());
        assert!(parse_duration("1🙂").is_err());
        assert!(parse_duration("abc").is_err());
        assert!(parse_duration("NaNs").is_err());
        assert!(parse_duration("Infinitys").is_err());
    }

    #[test]
    fn test_format_timestamp() {
        let ts = format_timestamp(1700000000000);
        assert!(ts.contains("2023"), "expected 2023 in timestamp, got: {ts}");
    }

    #[test]
    fn test_decode_encoded_words() {
        assert_eq!(
            decode_encoded_words("Confirm your email"),
            "Confirm your email"
        );
        assert_eq!(
            decode_encoded_words("=?UTF-8?Q?Gr=C3=BC=C3=9Fe_aus_Acme?="),
            "Grüße aus Acme"
        );
        assert_eq!(
            decode_encoded_words("=?utf-8?b?V2VsY29tZSDwn46J?="),
            "Welcome 🎉"
        );
        assert_eq!(
            decode_encoded_words("=?ISO-8859-1?Q?Caf=E9?= is open"),
            "Café is open"
        );
        assert_eq!(decode_encoded_words("=?UTF-8*en?Q?Hi?="), "Hi");
        // Whitespace between two words goes; around plain text it stays.
        assert_eq!(
            decode_encoded_words("=?UTF-8?Q?a?=  =?UTF-8?Q?b?= c"),
            "ab c"
        );
        // A character split across two words survives.
        assert_eq!(decode_encoded_words("=?UTF-8?Q?=C3?= =?UTF-8?Q?=BC?="), "ü");
        // Other charsets, broken words and stray markers are kept as written.
        assert_eq!(decode_encoded_words("=?KOI8-R?Q?abc?="), "=?KOI8-R?Q?abc?=");
        assert_eq!(decode_encoded_words("=?UTF-8?Q?=ZZ?="), "=?UTF-8?Q?=ZZ?=");
        assert_eq!(
            decode_encoded_words("Is 2+2 =? 4 ?= yes"),
            "Is 2+2 =? 4 ?= yes"
        );
    }

    #[test]
    fn test_format_iso() {
        let iso = format_iso(1700000000000);
        assert!(iso.starts_with("2023-"), "expected ISO date, got: {iso}");
        // -1ms is valid (just before epoch), verify it doesn't crash
        assert!(!format_iso(-1).is_empty());
    }
}
