//! A lenient tokenizer for content streams and CMaps.
//!
//! lopdf's content parser gives up on a whole stream at the first token it
//! does not like, which loses every word on a page with one odd operator.
//! This one skips what it cannot read and keeps going, never recurses (so
//! nesting depth cannot overflow the stack) and drops nested arrays past a
//! small depth.

/// Arrays nested deeper than this are read but their contents dropped.
const MAX_ARRAY_DEPTH: usize = 8;
/// A literal string longer than this keeps only its beginning.
const MAX_STRING_BYTES: usize = 1024 * 1024;
/// Operands kept before an operator; a stream of numbers with no operator
/// would otherwise pile up.
const MAX_OPERANDS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Token<'a> {
    Number(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    ArrayOpen,
    ArrayClose,
    DictOpen,
    DictClose,
    Keyword(&'a [u8]),
}

pub(crate) struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

fn is_whitespace(b: u8) -> bool {
    matches!(b, b'\0' | b'\t' | b'\n' | b'\x0C' | b'\r' | b' ')
}

fn is_delimiter(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_regular(b: u8) -> bool {
    !is_whitespace(b) && !is_delimiter(b)
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

impl<'a> Lexer<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn skip_whitespace_and_comments(&mut self) {
        while let Some(&b) = self.data.get(self.pos) {
            if is_whitespace(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(&c) = self.data.get(self.pos) {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    pub(crate) fn next_token(&mut self) -> Option<Token<'a>> {
        loop {
            self.skip_whitespace_and_comments();
            let &b = self.data.get(self.pos)?;
            match b {
                b'/' => {
                    self.pos += 1;
                    return Some(Token::Name(self.name()));
                }
                b'(' => {
                    self.pos += 1;
                    return Some(Token::Str(self.literal_string()));
                }
                b'<' if self.data.get(self.pos + 1) == Some(&b'<') => {
                    self.pos += 2;
                    return Some(Token::DictOpen);
                }
                b'<' => {
                    self.pos += 1;
                    return Some(Token::Str(self.hex_string()));
                }
                b'>' if self.data.get(self.pos + 1) == Some(&b'>') => {
                    self.pos += 2;
                    return Some(Token::DictClose);
                }
                b'[' => {
                    self.pos += 1;
                    return Some(Token::ArrayOpen);
                }
                b']' => {
                    self.pos += 1;
                    return Some(Token::ArrayClose);
                }
                b'{' | b'}' => {
                    self.pos += 1;
                    return Some(Token::Keyword(&self.data[self.pos - 1..self.pos]));
                }
                b')' | b'>' => {
                    // A stray closing delimiter: skip it.
                    self.pos += 1;
                }
                _ => {
                    let start = self.pos;
                    while self.data.get(self.pos).is_some_and(|&c| is_regular(c)) {
                        self.pos += 1;
                    }
                    let word = &self.data[start..self.pos];
                    if matches!(word[0], b'0'..=b'9' | b'+' | b'-' | b'.') {
                        return Some(Token::Number(parse_number(word)));
                    }
                    return Some(Token::Keyword(word));
                }
            }
        }
    }

    fn name(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        while let Some(&b) = self.data.get(self.pos) {
            if !is_regular(b) {
                break;
            }
            self.pos += 1;
            if b == b'#'
                && let (Some(h), Some(l)) = (
                    self.data.get(self.pos).copied().and_then(hex_value),
                    self.data.get(self.pos + 1).copied().and_then(hex_value),
                )
            {
                out.push(h << 4 | l);
                self.pos += 2;
                continue;
            }
            out.push(b);
        }
        out
    }

    fn literal_string(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut depth = 1usize;
        while let Some(&b) = self.data.get(self.pos) {
            self.pos += 1;
            let byte = match b {
                b'(' => {
                    depth += 1;
                    b'('
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    b')'
                }
                b'\\' => {
                    let Some(&e) = self.data.get(self.pos) else {
                        break;
                    };
                    self.pos += 1;
                    match e {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.data.get(self.pos) {
                                    Some(&d @ b'0'..=b'7') => {
                                        v = v * 8 + u32::from(d - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            (v & 0xFF) as u8
                        }
                        b'\r' => {
                            // A backslash at the end of a line continues it.
                            if self.data.get(self.pos) == Some(&b'\n') {
                                self.pos += 1;
                            }
                            continue;
                        }
                        b'\n' => continue,
                        other => other,
                    }
                }
                other => other,
            };
            if out.len() < MAX_STRING_BYTES {
                out.push(byte);
            }
        }
        out
    }

    fn hex_string(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut high: Option<u8> = None;
        while let Some(&b) = self.data.get(self.pos) {
            self.pos += 1;
            if b == b'>' {
                break;
            }
            let Some(v) = hex_value(b) else {
                continue;
            };
            match high.take() {
                Some(h) => {
                    if out.len() < MAX_STRING_BYTES {
                        out.push(h << 4 | v);
                    }
                }
                None => high = Some(v),
            }
        }
        if let Some(h) = high {
            out.push(h << 4);
        }
        out
    }

    /// Skips an inline image after its `ID` keyword: binary data up to an
    /// `EI` that stands alone between whitespace.
    fn skip_inline_image_data(&mut self) {
        // One whitespace byte separates ID from the data.
        self.pos += 1;
        let data = self.data;
        let mut i = self.pos;
        while i + 1 < data.len() {
            if data[i] == b'E'
                && data[i + 1] == b'I'
                && i > 0
                && is_whitespace(data[i - 1])
                && data
                    .get(i + 2)
                    .is_none_or(|&c| is_whitespace(c) || is_delimiter(c))
            {
                self.pos = i + 2;
                return;
            }
            i += 1;
        }
        self.pos = data.len();
    }
}

fn parse_number(word: &[u8]) -> f64 {
    let s = std::str::from_utf8(word).unwrap_or("0");
    if let Ok(v) = s.parse::<f64>()
        && v.is_finite()
    {
        return v;
    }
    // Writers produce things like "--5" or "1.2.3"; keep the leading
    // well-formed part, as viewers do.
    let mut end = 0;
    let mut seen_dot = false;
    for (i, c) in s.char_indices() {
        let ok = match c {
            '+' | '-' => i == 0,
            '.' if !seen_dot => {
                seen_dot = true;
                true
            }
            '0'..='9' => true,
            _ => false,
        };
        if !ok {
            break;
        }
        end = i + 1;
    }
    s[..end]
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Operand {
    Number(f64),
    Name(Vec<u8>),
    Str(Vec<u8>),
    Array(Vec<Operand>),
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Operation<'a> {
    pub op: &'a [u8],
    pub operands: Vec<Operand>,
}

/// Groups content stream tokens into operations (operands, then operator).
pub(crate) struct Operations<'a> {
    lexer: Lexer<'a>,
}

impl<'a> Operations<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self {
            lexer: Lexer::new(data),
        }
    }

    /// Reads an array whose `[` was just consumed, without recursion.
    fn array(&mut self) -> Operand {
        let mut stack: Vec<Vec<Operand>> = vec![Vec::new()];
        // Depth of arrays nested past MAX_ARRAY_DEPTH, whose contents we drop.
        let mut dropped = 0usize;
        while let Some(token) = self.lexer.next_token() {
            let item = match token {
                Token::ArrayOpen => {
                    if stack.len() >= MAX_ARRAY_DEPTH || dropped > 0 {
                        dropped += 1;
                    } else {
                        stack.push(Vec::new());
                    }
                    continue;
                }
                Token::ArrayClose => {
                    if dropped > 0 {
                        dropped -= 1;
                        continue;
                    }
                    let done = stack.pop().unwrap_or_default();
                    match stack.last_mut() {
                        Some(parent) => {
                            parent.push(Operand::Array(done));
                            continue;
                        }
                        None => return Operand::Array(done),
                    }
                }
                Token::DictOpen => {
                    self.skip_dict();
                    Operand::Other
                }
                Token::Number(n) => Operand::Number(n),
                Token::Name(n) => Operand::Name(n),
                Token::Str(s) => Operand::Str(s),
                Token::DictClose | Token::Keyword(_) => continue,
            };
            if dropped == 0
                && let Some(top) = stack.last_mut()
            {
                top.push(item);
            }
        }
        // The stream ended inside the array: close what is open.
        while stack.len() > 1 {
            let done = stack.pop().unwrap_or_default();
            if let Some(parent) = stack.last_mut() {
                parent.push(Operand::Array(done));
            }
        }
        Operand::Array(stack.pop().unwrap_or_default())
    }

    /// Skips a dictionary whose `<<` was just consumed. Its contents (marked
    /// content properties, inline image parameters) carry no text we use.
    fn skip_dict(&mut self) {
        let mut depth = 1usize;
        while let Some(token) = self.lexer.next_token() {
            match token {
                Token::DictOpen => depth += 1,
                Token::DictClose => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    /// Skips `BI <params> ID <data> EI`; the `BI` was just consumed.
    fn skip_inline_image(&mut self) {
        while let Some(token) = self.lexer.next_token() {
            if token == Token::Keyword(b"ID") {
                self.lexer.skip_inline_image_data();
                return;
            }
        }
    }
}

impl<'a> Iterator for Operations<'a> {
    type Item = Operation<'a>;

    fn next(&mut self) -> Option<Operation<'a>> {
        let mut operands = Vec::new();
        loop {
            let operand = match self.lexer.next_token()? {
                Token::Number(n) => Operand::Number(n),
                Token::Name(n) => Operand::Name(n),
                Token::Str(s) => Operand::Str(s),
                Token::ArrayOpen => self.array(),
                Token::DictOpen => {
                    self.skip_dict();
                    Operand::Other
                }
                Token::ArrayClose | Token::DictClose => continue,
                Token::Keyword(b"true" | b"false" | b"null") => Operand::Other,
                Token::Keyword(b"BI") => {
                    self.skip_inline_image();
                    operands.clear();
                    continue;
                }
                Token::Keyword(op) => return Some(Operation { op, operands }),
            };
            if operands.len() >= MAX_OPERANDS {
                operands.drain(..MAX_OPERANDS / 2);
            }
            operands.push(operand);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(data: &[u8]) -> Vec<(String, Vec<Operand>)> {
        Operations::new(data)
            .map(|o| (String::from_utf8_lossy(o.op).into_owned(), o.operands))
            .collect()
    }

    #[test]
    fn reads_text_operators() {
        let got = ops(b"BT /F1 12 Tf 72 712 Td (Hello \\(world\\)) Tj [(A) -250 (B)] TJ ET");
        assert_eq!(got[0].0, "BT");
        assert_eq!(
            got[1],
            (
                "Tf".to_string(),
                vec![Operand::Name(b"F1".to_vec()), Operand::Number(12.0)]
            )
        );
        assert_eq!(got[3].1, vec![Operand::Str(b"Hello (world)".to_vec())]);
        assert_eq!(
            got[4].1,
            vec![Operand::Array(vec![
                Operand::Str(b"A".to_vec()),
                Operand::Number(-250.0),
                Operand::Str(b"B".to_vec()),
            ])]
        );
    }

    #[test]
    fn strings_names_and_numbers() {
        let mut lexer =
            Lexer::new(b"<48 65 6c6C 6f> (a\\101\\nb) /A#42 -.5 --3 1.2.3 % comment\n(x");
        assert_eq!(lexer.next_token(), Some(Token::Str(b"Hello".to_vec())));
        assert_eq!(lexer.next_token(), Some(Token::Str(b"aA\nb".to_vec())));
        assert_eq!(lexer.next_token(), Some(Token::Name(b"AB".to_vec())));
        assert_eq!(lexer.next_token(), Some(Token::Number(-0.5)));
        assert_eq!(lexer.next_token(), Some(Token::Number(0.0)));
        assert_eq!(lexer.next_token(), Some(Token::Number(1.2)));
        assert_eq!(lexer.next_token(), Some(Token::Str(b"x".to_vec())));
        assert_eq!(lexer.next_token(), None);
    }

    #[test]
    fn inline_images_are_skipped() {
        let got = ops(b"BI /W 4 /H 4 ID \x00EI\xff\x01 EI Q (after) Tj");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "Q");
        assert_eq!(got[1].1, vec![Operand::Str(b"after".to_vec())]);
    }

    #[test]
    fn deep_nesting_does_not_recurse() {
        let mut data = vec![b'['; 1_000_000];
        data.extend(vec![b']'; 1_000_000]);
        data.extend_from_slice(b" TJ");
        let got = ops(&data);
        assert_eq!(got.len(), 1);
        let mut data = b"<<".repeat(500_000);
        data.extend(b">>".repeat(500_000));
        data.extend_from_slice(b" BDC (t) Tj");
        assert_eq!(ops(&data).last().unwrap().0, "Tj");
    }

    #[test]
    fn unterminated_constructs_end_at_the_data() {
        assert_eq!(ops(b"[(a) (b"), vec![]);
        assert_eq!(ops(b"(abc"), vec![]);
        assert_eq!(ops(b"<414"), vec![]);
        let mut lexer = Lexer::new(b"<414");
        assert_eq!(lexer.next_token(), Some(Token::Str(vec![0x41, 0x40])));
    }

    #[test]
    fn operand_piles_are_bounded() {
        let data = "1 ".repeat(100_000) + "Tj";
        let got = ops(data.as_bytes());
        assert!(got[0].1.len() <= MAX_OPERANDS);
    }
}
