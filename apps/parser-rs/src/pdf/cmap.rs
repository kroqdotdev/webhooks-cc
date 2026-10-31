//! CMaps: code space ranges (how many bytes a character code takes) and
//! ToUnicode mappings (which text a code stands for).
//!
//! Ranges are stored as ranges, never expanded, so `<0000> <FFFF> <0000>`
//! costs one entry rather than 65,536.

use std::collections::HashMap;

use super::glyphs::glyph_to_text;
use super::lexer::{Lexer, Token};

/// Mappings kept from one CMap; a real font needs at most tens of thousands.
const MAX_ENTRIES: usize = 500_000;
/// Elements kept from one array destination of a bfrange.
const MAX_RANGE_LIST: usize = 65_536;

#[derive(Debug, Default)]
pub(crate) struct CMap {
    /// (code length in bytes, low, high).
    codespace: Vec<(u8, u32, u32)>,
    chars: HashMap<(u8, u32), String>,
    /// Sorted by (length, low) once parsing is done.
    ranges: Vec<Range>,
}

#[derive(Debug)]
struct Range {
    len: u8,
    lo: u32,
    hi: u32,
    dst: Dst,
}

#[derive(Debug)]
enum Dst {
    /// The text of `lo`; later codes increment its last UTF-16 unit.
    Base(Vec<u16>),
    List(Vec<String>),
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    None,
    Codespace,
    BfChar,
    BfRange,
}

/// A code from a hex string: up to four bytes, big-endian.
fn code_of(bytes: &[u8]) -> Option<(u8, u32)> {
    if bytes.is_empty() || bytes.len() > 4 {
        return None;
    }
    let v = bytes.iter().fold(0u32, |acc, &b| acc << 8 | u32::from(b));
    Some((bytes.len() as u8, v))
}

/// Destination strings are UTF-16BE.
fn utf16_units(bytes: &[u8]) -> Vec<u16> {
    bytes
        .chunks(2)
        .map(|c| u16::from_be_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
        .collect()
}

fn text_of_units(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|c| c.unwrap_or('\u{FFFD}'))
        .collect()
}

fn text_of_token(token: &Token<'_>) -> Option<String> {
    match token {
        Token::Str(s) => Some(text_of_units(&utf16_units(s))),
        Token::Name(n) => glyph_to_text(n),
        _ => None,
    }
}

impl CMap {
    pub(crate) fn parse(data: &[u8]) -> CMap {
        let mut cmap = CMap::default();
        let mut lexer = Lexer::new(data);
        let mut section = Section::None;
        let mut pending: Vec<Token<'_>> = Vec::new();
        let mut entries = 0usize;
        while let Some(token) = lexer.next_token() {
            if let Token::Keyword(k) = token {
                section = match k {
                    b"begincodespacerange" => Section::Codespace,
                    b"beginbfchar" => Section::BfChar,
                    b"beginbfrange" => Section::BfRange,
                    _ => Section::None,
                };
                pending.clear();
                continue;
            }
            if section == Section::None || entries >= MAX_ENTRIES {
                continue;
            }
            if section == Section::BfRange && token == Token::ArrayOpen {
                // An array destination: read its strings up to `]`.
                let mut list = Vec::new();
                while let Some(t) = lexer.next_token() {
                    match t {
                        Token::ArrayClose => break,
                        Token::Keyword(_) => break,
                        t => {
                            if list.len() < MAX_RANGE_LIST {
                                list.push(text_of_token(&t).unwrap_or_default());
                            }
                        }
                    }
                }
                if pending.len() == 2
                    && let (Token::Str(lo), Token::Str(hi)) = (&pending[0], &pending[1])
                    && let (Some((len, lo)), Some((_, hi))) = (code_of(lo), code_of(hi))
                    && lo <= hi
                {
                    cmap.ranges.push(Range {
                        len,
                        lo,
                        hi,
                        dst: Dst::List(list),
                    });
                    entries += 1;
                }
                pending.clear();
                continue;
            }
            pending.push(token);
            match section {
                Section::Codespace if pending.len() == 2 => {
                    if let (Token::Str(lo), Token::Str(hi)) = (&pending[0], &pending[1])
                        && let (Some((len, lo)), Some((_, hi))) = (code_of(lo), code_of(hi))
                    {
                        cmap.codespace.push((len, lo, hi));
                        entries += 1;
                    }
                    pending.clear();
                }
                Section::BfChar if pending.len() == 2 => {
                    if let Token::Str(src) = &pending[0]
                        && let Some(code) = code_of(src)
                        && let Some(text) = text_of_token(&pending[1])
                    {
                        cmap.chars.insert(code, text);
                        entries += 1;
                    }
                    pending.clear();
                }
                Section::BfRange if pending.len() == 3 => {
                    if let (Token::Str(lo), Token::Str(hi), Token::Str(dst)) =
                        (&pending[0], &pending[1], &pending[2])
                        && let (Some((len, lo)), Some((_, hi))) = (code_of(lo), code_of(hi))
                        && lo <= hi
                    {
                        cmap.ranges.push(Range {
                            len,
                            lo,
                            hi,
                            dst: Dst::Base(utf16_units(dst)),
                        });
                        entries += 1;
                    }
                    pending.clear();
                }
                _ => {}
            }
        }
        cmap.ranges.sort_by_key(|r| (r.len, r.lo));
        cmap
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.chars.is_empty() && self.ranges.is_empty()
    }

    pub(crate) fn has_codespace(&self) -> bool {
        !self.codespace.is_empty()
    }

    /// How many bytes the code at the start of `bytes` takes, from the code
    /// space ranges. A code that fits no range takes the shortest length,
    /// as PDF viewers do.
    pub(crate) fn code_len(&self, bytes: &[u8]) -> usize {
        for n in 1..=4usize.min(bytes.len()) {
            let Some((_, code)) = code_of(&bytes[..n]) else {
                continue;
            };
            if self
                .codespace
                .iter()
                .any(|&(len, lo, hi)| usize::from(len) == n && (lo..=hi).contains(&code))
            {
                return n;
            }
        }
        self.codespace
            .iter()
            .map(|&(len, _, _)| usize::from(len))
            .min()
            .unwrap_or(1)
            .max(1)
    }

    /// The text for a code of `len` bytes.
    pub(crate) fn lookup(&self, len: u8, code: u32) -> Option<String> {
        if let Some(text) = self.chars.get(&(len, code)) {
            return Some(text.clone());
        }
        // The last range starting at or before the code.
        let i = self
            .ranges
            .partition_point(|r| (r.len, r.lo) <= (len, code));
        let range = self.ranges.get(i.checked_sub(1)?)?;
        if range.len != len || code > range.hi {
            return None;
        }
        let offset = code - range.lo;
        match &range.dst {
            Dst::Base(units) => {
                let mut units = units.clone();
                let last = units.last_mut()?;
                *last = last.wrapping_add(offset as u16);
                Some(text_of_units(&units))
            }
            Dst::List(list) => list.get(offset as usize).cloned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap
        1 begincodespacerange <0000> <FFFF> endcodespacerange
        2 beginbfchar <0003> <0020> <0024> <00410042> endbfchar
        2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<00E9> /eacute] endbfrange
        endcmap CMapName currentdict /CMap defineresource pop end end";

    #[test]
    fn parses_chars_and_ranges() {
        let cmap = CMap::parse(SAMPLE);
        assert_eq!(cmap.lookup(2, 0x03).as_deref(), Some(" "));
        assert_eq!(cmap.lookup(2, 0x24).as_deref(), Some("AB"));
        assert_eq!(cmap.lookup(2, 0x10).as_deref(), Some("a"));
        assert_eq!(cmap.lookup(2, 0x12).as_deref(), Some("c"));
        assert_eq!(cmap.lookup(2, 0x13), None);
        assert_eq!(cmap.lookup(2, 0x21).as_deref(), Some("é"));
        assert_eq!(cmap.lookup(1, 0x03), None);
        assert_eq!(cmap.code_len(&[0x00, 0x03]), 2);
    }

    #[test]
    fn huge_ranges_are_not_expanded() {
        let cmap = CMap::parse(b"beginbfrange <00000000> <FFFFFFFF> <0041> endbfrange");
        assert_eq!(cmap.ranges.len(), 1);
        assert_eq!(cmap.lookup(4, 2).as_deref(), Some("C"));
    }

    #[test]
    fn mixed_code_lengths() {
        let cmap = CMap::parse(b"begincodespacerange <00> <80> <8140> <9FFC> endcodespacerange");
        assert_eq!(cmap.code_len(b"A"), 1);
        assert_eq!(cmap.code_len(&[0x81, 0x40]), 2);
        assert_eq!(cmap.code_len(&[0xFF]), 1);
    }

    #[test]
    fn garbage_gives_an_empty_map() {
        let cmap = CMap::parse(b"beginbfchar <01> endbfchar ] ] >> (((");
        assert!(cmap.is_empty());
    }
}
