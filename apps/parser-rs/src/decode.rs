//! Character decoding for the text-based formats (CSV, TSV, plain text).
//!
//! Attachments arrive in whatever encoding the sender's software used.
//! Excel's "Unicode Text" export is UTF-16 with a byte order mark, older
//! Windows exports are Windows-1252, everything modern is UTF-8.

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};

/// Decodes `bytes` to a string: a byte order mark wins, valid UTF-8 is taken
/// as is, and anything else is either UTF-8 with a few bad bytes (replaced
/// with U+FFFD) or a legacy single-byte file (read as Windows-1252).
pub(crate) fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return UTF_16LE.decode_without_bom_handling(rest).0.into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return UTF_16BE.decode_without_bom_handling(rest).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) if mostly_utf8(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        Err(_) => WINDOWS_1252
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

/// Whether `bytes` holds UTF-8 with some damage rather than a legacy
/// encoding: a Windows-1252 file almost never contains a valid multi-byte
/// UTF-8 sequence, so more valid non-ASCII characters than invalid
/// sequences means UTF-8.
fn mostly_utf8(bytes: &[u8]) -> bool {
    let mut valid_non_ascii = 0usize;
    let mut invalid = 0usize;
    for chunk in bytes.utf8_chunks() {
        valid_non_ascii += chunk.valid().chars().filter(|c| !c.is_ascii()).count();
        if !chunk.invalid().is_empty() {
            invalid += 1;
        }
    }
    valid_non_ascii > invalid
}

/// Whether the bytes start with a UTF-16 byte order mark.
pub(crate) fn is_utf16(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_with_and_without_bom() {
        assert_eq!(decode_text("a,é".as_bytes()), "a,é");
        assert_eq!(decode_text(b"\xEF\xBB\xBFa,b"), "a,b");
    }

    #[test]
    fn utf16_with_bom() {
        assert_eq!(decode_text(b"\xFF\xFEa\0,\0b\0"), "a,b");
        assert_eq!(decode_text(b"\xFE\xFF\0a\0,\0b"), "a,b");
    }

    #[test]
    fn windows_1252_fallback() {
        // "café" and a euro sign in Windows-1252.
        assert_eq!(decode_text(b"caf\xE9 \x80"), "café €");
    }

    #[test]
    fn mostly_utf8_keeps_utf8_and_replaces_the_bad_byte() {
        assert_eq!(decode_text("é é \u{20ac} ".as_bytes()), "é é \u{20ac} ");
        let mut bytes = "é é ".as_bytes().to_vec();
        bytes.push(0xFF);
        assert_eq!(decode_text(&bytes), "é é \u{FFFD}");
    }
}
