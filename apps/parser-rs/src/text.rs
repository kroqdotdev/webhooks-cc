//! Plain text attachments (txt, json, xml, ics): the first MiB, decoded.

use crate::decode::{decode_text, is_utf16};
use crate::output::{ErrorCode, Failure};

/// Text past this is dropped and the output marked truncated.
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Returns the decoded text and whether it was cut.
pub(crate) fn parse(input: &[u8]) -> Result<(String, bool), Failure> {
    let truncated = input.len() > MAX_TEXT_BYTES;
    let mut slice = &input[..input.len().min(MAX_TEXT_BYTES)];
    if truncated {
        if is_utf16(input) {
            // Never split a UTF-16 code unit.
            slice = &slice[..slice.len() & !1];
        } else if let Err(e) = std::str::from_utf8(slice)
            && e.error_len().is_none()
        {
            // The cut landed inside a UTF-8 sequence: drop the partial
            // character instead of turning it into U+FFFD.
            slice = &slice[..e.valid_up_to()];
        }
    }
    let mut text = decode_text(slice);
    text.retain(|c| c != '\0');
    if text.trim().is_empty() {
        return Err(Failure::new(ErrorCode::Empty, "the file has no text"));
    }
    Ok((text, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_returned_whole() {
        assert_eq!(parse(b"hello\n").unwrap(), ("hello\n".to_string(), false));
    }

    #[test]
    fn empty_and_blank_text_is_empty() {
        assert_eq!(parse(b"").unwrap_err().code, ErrorCode::Empty);
        assert_eq!(parse(b" \n\t\r\n").unwrap_err().code, ErrorCode::Empty);
        assert_eq!(parse(b"\0\0").unwrap_err().code, ErrorCode::Empty);
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        let mut input = vec![b'a'; MAX_TEXT_BYTES - 1];
        input.extend_from_slice("é and more".as_bytes());
        let (text, truncated) = parse(&input).unwrap();
        assert!(truncated);
        assert_eq!(text.len(), MAX_TEXT_BYTES - 1);
        assert!(!text.contains('\u{FFFD}'));
    }

    #[test]
    fn long_utf16_text_is_cut_on_a_code_unit() {
        let mut input = b"\xFF\xFE".to_vec();
        input.extend(std::iter::repeat_n([b'a', 0], MAX_TEXT_BYTES).flatten());
        let (text, truncated) = parse(&input).unwrap();
        assert!(truncated);
        assert!(text.chars().all(|c| c == 'a'));
    }
}
