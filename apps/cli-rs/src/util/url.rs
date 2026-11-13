//! Percent-encoding for path segments and query values.

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, PercentEncode, utf8_percent_encode};

/// RFC 3986's unreserved characters stay as they are; everything else,
/// non-ASCII included, becomes `%XX` in uppercase hex. A space is `%20`,
/// never `+`.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// One path segment or query value, encoded for a URL.
pub fn encode(input: &str) -> PercentEncode<'_> {
    utf8_percent_encode(input, COMPONENT)
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(encode("AZaz09-._~").to_string(), "AZaz09-._~");
        assert_eq!(
            encode("a b+c/d?e&f=g#h%").to_string(),
            "a%20b%2Bc%2Fd%3Fe%26f%3Dg%23h%25"
        );
        assert_eq!(encode("æ€").to_string(), "%C3%A6%E2%82%AC");
        assert_eq!(encode("").to_string(), "");
    }

    #[test]
    fn escapes_every_other_ascii_byte() {
        for byte in 0u8..128 {
            let ch = byte as char;
            let kept = ch.is_ascii_alphanumeric() || "-._~".contains(ch);
            let encoded = encode(&ch.to_string()).to_string();
            if kept {
                assert_eq!(encoded, ch.to_string());
            } else {
                assert_eq!(encoded, format!("%{byte:02X}"));
            }
        }
    }
}
