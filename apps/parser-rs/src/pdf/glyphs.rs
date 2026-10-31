//! Glyph names, the standard font encodings and the metrics of the core
//! fonts: what a PDF without a ToUnicode map needs to be read as text.

use encoding_rs::{MACINTOSH, WINDOWS_1252};

/// Adobe glyph names for the Latin characters the standard encodings use,
/// sorted by name for binary search. Names outside this list are handled
/// by [`glyph_to_text`] (uniXXXX, uXXXX, ligatures and suffixes).
const GLYPHS: &[(&str, &str)] = &[
    ("A", "A"),
    ("AE", "Æ"),
    ("Aacute", "Á"),
    ("Abreve", "Ă"),
    ("Acircumflex", "Â"),
    ("Adieresis", "Ä"),
    ("Agrave", "À"),
    ("Amacron", "Ā"),
    ("Aogonek", "Ą"),
    ("Aring", "Å"),
    ("Atilde", "Ã"),
    ("B", "B"),
    ("C", "C"),
    ("Cacute", "Ć"),
    ("Ccaron", "Č"),
    ("Ccedilla", "Ç"),
    ("D", "D"),
    ("Dcaron", "Ď"),
    ("Dcroat", "Đ"),
    ("Delta", "∆"),
    ("E", "E"),
    ("Eacute", "É"),
    ("Ecaron", "Ě"),
    ("Ecircumflex", "Ê"),
    ("Edieresis", "Ë"),
    ("Edotaccent", "Ė"),
    ("Egrave", "È"),
    ("Emacron", "Ē"),
    ("Eogonek", "Ę"),
    ("Eth", "Ð"),
    ("Euro", "€"),
    ("F", "F"),
    ("G", "G"),
    ("Gbreve", "Ğ"),
    ("H", "H"),
    ("I", "I"),
    ("Iacute", "Í"),
    ("Icircumflex", "Î"),
    ("Idieresis", "Ï"),
    ("Idotaccent", "İ"),
    ("Igrave", "Ì"),
    ("Imacron", "Ī"),
    ("Iogonek", "Į"),
    ("J", "J"),
    ("K", "K"),
    ("L", "L"),
    ("Lacute", "Ĺ"),
    ("Lcaron", "Ľ"),
    ("Lslash", "Ł"),
    ("M", "M"),
    ("N", "N"),
    ("Nacute", "Ń"),
    ("Ncaron", "Ň"),
    ("Ntilde", "Ñ"),
    ("O", "O"),
    ("OE", "Œ"),
    ("Oacute", "Ó"),
    ("Ocircumflex", "Ô"),
    ("Odieresis", "Ö"),
    ("Ograve", "Ò"),
    ("Ohungarumlaut", "Ő"),
    ("Omacron", "Ō"),
    ("Omega", "Ω"),
    ("Oslash", "Ø"),
    ("Otilde", "Õ"),
    ("P", "P"),
    ("Q", "Q"),
    ("R", "R"),
    ("Racute", "Ŕ"),
    ("Rcaron", "Ř"),
    ("S", "S"),
    ("Sacute", "Ś"),
    ("Scaron", "Š"),
    ("Scedilla", "Ş"),
    ("T", "T"),
    ("Tcaron", "Ť"),
    ("Thorn", "Þ"),
    ("U", "U"),
    ("Uacute", "Ú"),
    ("Ucircumflex", "Û"),
    ("Udieresis", "Ü"),
    ("Ugrave", "Ù"),
    ("Uhungarumlaut", "Ű"),
    ("Umacron", "Ū"),
    ("Uogonek", "Ų"),
    ("Uring", "Ů"),
    ("V", "V"),
    ("W", "W"),
    ("X", "X"),
    ("Y", "Y"),
    ("Yacute", "Ý"),
    ("Ydieresis", "Ÿ"),
    ("Z", "Z"),
    ("Zacute", "Ź"),
    ("Zcaron", "Ž"),
    ("Zdotaccent", "Ż"),
    ("a", "a"),
    ("aacute", "á"),
    ("abreve", "ă"),
    ("acircumflex", "â"),
    ("acute", "´"),
    ("adieresis", "ä"),
    ("ae", "æ"),
    ("agrave", "à"),
    ("amacron", "ā"),
    ("ampersand", "&"),
    ("aogonek", "ą"),
    ("approxequal", "≈"),
    ("aring", "å"),
    ("asciicircum", "^"),
    ("asciitilde", "~"),
    ("asterisk", "*"),
    ("at", "@"),
    ("atilde", "ã"),
    ("b", "b"),
    ("backslash", "\\"),
    ("bar", "|"),
    ("braceleft", "{"),
    ("braceright", "}"),
    ("bracketleft", "["),
    ("bracketright", "]"),
    ("breve", "˘"),
    ("brokenbar", "¦"),
    ("bullet", "•"),
    ("c", "c"),
    ("cacute", "ć"),
    ("caron", "ˇ"),
    ("ccaron", "č"),
    ("ccedilla", "ç"),
    ("cedilla", "¸"),
    ("cent", "¢"),
    ("circumflex", "ˆ"),
    ("colon", ":"),
    ("comma", ","),
    ("copyright", "©"),
    ("currency", "¤"),
    ("d", "d"),
    ("dagger", "†"),
    ("daggerdbl", "‡"),
    ("dcaron", "ď"),
    ("dcroat", "đ"),
    ("degree", "°"),
    ("dieresis", "¨"),
    ("divide", "÷"),
    ("dollar", "$"),
    ("dotaccent", "˙"),
    ("dotlessi", "ı"),
    ("e", "e"),
    ("eacute", "é"),
    ("ecaron", "ě"),
    ("ecircumflex", "ê"),
    ("edieresis", "ë"),
    ("edotaccent", "ė"),
    ("egrave", "è"),
    ("eight", "8"),
    ("ellipsis", "…"),
    ("emacron", "ē"),
    ("emdash", "\u{2014}"),
    ("endash", "–"),
    ("eogonek", "ę"),
    ("equal", "="),
    ("eth", "ð"),
    ("exclam", "!"),
    ("exclamdown", "¡"),
    ("f", "f"),
    ("ff", "ff"),
    ("ffi", "ffi"),
    ("ffl", "ffl"),
    ("fi", "fi"),
    ("five", "5"),
    ("fl", "fl"),
    ("florin", "ƒ"),
    ("four", "4"),
    ("fraction", "⁄"),
    ("g", "g"),
    ("gbreve", "ğ"),
    ("germandbls", "ß"),
    ("grave", "`"),
    ("greater", ">"),
    ("greaterequal", "≥"),
    ("guillemotleft", "«"),
    ("guillemotright", "»"),
    ("guilsinglleft", "‹"),
    ("guilsinglright", "›"),
    ("h", "h"),
    ("hungarumlaut", "˝"),
    ("hyphen", "-"),
    ("i", "i"),
    ("iacute", "í"),
    ("icircumflex", "î"),
    ("idieresis", "ï"),
    ("igrave", "ì"),
    ("imacron", "ī"),
    ("infinity", "∞"),
    ("integral", "∫"),
    ("iogonek", "į"),
    ("j", "j"),
    ("k", "k"),
    ("l", "l"),
    ("lacute", "ĺ"),
    ("lcaron", "ľ"),
    ("less", "<"),
    ("lessequal", "≤"),
    ("logicalnot", "¬"),
    ("lozenge", "◊"),
    ("lslash", "ł"),
    ("m", "m"),
    ("macron", "¯"),
    ("minus", "−"),
    ("mu", "µ"),
    ("multiply", "×"),
    ("n", "n"),
    ("nacute", "ń"),
    ("nbspace", "\u{a0}"),
    ("ncaron", "ň"),
    ("nine", "9"),
    ("notequal", "≠"),
    ("ntilde", "ñ"),
    ("numbersign", "#"),
    ("o", "o"),
    ("oacute", "ó"),
    ("ocircumflex", "ô"),
    ("odieresis", "ö"),
    ("oe", "œ"),
    ("ogonek", "˛"),
    ("ograve", "ò"),
    ("ohungarumlaut", "ő"),
    ("omacron", "ō"),
    ("one", "1"),
    ("onehalf", "½"),
    ("onequarter", "¼"),
    ("onesuperior", "¹"),
    ("ordfeminine", "ª"),
    ("ordmasculine", "º"),
    ("oslash", "ø"),
    ("otilde", "õ"),
    ("p", "p"),
    ("paragraph", "¶"),
    ("parenleft", "("),
    ("parenright", ")"),
    ("partialdiff", "∂"),
    ("percent", "%"),
    ("period", "."),
    ("periodcentered", "·"),
    ("perthousand", "‰"),
    ("pi", "π"),
    ("plus", "+"),
    ("plusminus", "±"),
    ("product", "∏"),
    ("q", "q"),
    ("question", "?"),
    ("questiondown", "¿"),
    ("quotedbl", "\""),
    ("quotedblbase", "„"),
    ("quotedblleft", "“"),
    ("quotedblright", "”"),
    ("quoteleft", "‘"),
    ("quoteright", "’"),
    ("quotesinglbase", "‚"),
    ("quotesingle", "'"),
    ("r", "r"),
    ("racute", "ŕ"),
    ("radical", "√"),
    ("rcaron", "ř"),
    ("registered", "®"),
    ("ring", "˚"),
    ("s", "s"),
    ("sacute", "ś"),
    ("scaron", "š"),
    ("scedilla", "ş"),
    ("section", "§"),
    ("semicolon", ";"),
    ("seven", "7"),
    ("sfthyphen", "\u{ad}"),
    ("six", "6"),
    ("slash", "/"),
    ("space", " "),
    ("sterling", "£"),
    ("summation", "∑"),
    ("t", "t"),
    ("tcaron", "ť"),
    ("thorn", "þ"),
    ("three", "3"),
    ("threequarters", "¾"),
    ("threesuperior", "³"),
    ("tilde", "˜"),
    ("trademark", "™"),
    ("two", "2"),
    ("twosuperior", "²"),
    ("u", "u"),
    ("uacute", "ú"),
    ("ucircumflex", "û"),
    ("udieresis", "ü"),
    ("ugrave", "ù"),
    ("uhungarumlaut", "ű"),
    ("umacron", "ū"),
    ("underscore", "_"),
    ("uogonek", "ų"),
    ("uring", "ů"),
    ("v", "v"),
    ("w", "w"),
    ("x", "x"),
    ("y", "y"),
    ("yacute", "ý"),
    ("ydieresis", "ÿ"),
    ("yen", "¥"),
    ("z", "z"),
    ("zacute", "ź"),
    ("zcaron", "ž"),
    ("zdotaccent", "ż"),
    ("zero", "0"),
];

/// The text a glyph name stands for, following the Adobe Glyph List rules
/// for names not in the table: `uniXXXX` (one or more groups of four hex
/// digits), `uXXXX` to `uXXXXXX`, a `.suffix` to ignore, and `_` joining
/// the components of a ligature.
pub(crate) fn glyph_to_text(name: &[u8]) -> Option<String> {
    let name = std::str::from_utf8(name).ok()?;
    let base = name.split('.').next().unwrap_or(name);
    if base.is_empty() {
        return None;
    }
    if base.contains('_') {
        let parts: Option<String> = base
            .split('_')
            .map(|p| glyph_to_text(p.as_bytes()))
            .collect();
        return parts.filter(|s| !s.is_empty());
    }
    if let Ok(i) = GLYPHS.binary_search_by(|(n, _)| (*n).cmp(base)) {
        return Some(GLYPHS[i].1.to_string());
    }
    if let Some(hex) = base.strip_prefix("uni")
        && !hex.is_empty()
        && hex.len() % 4 == 0
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let units: Vec<u16> = hex
            .as_bytes()
            .chunks(4)
            .filter_map(|c| u16::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok())
            .collect();
        let s: String = char::decode_utf16(units)
            .map(|c| c.unwrap_or('\u{FFFD}'))
            .collect();
        return Some(s);
    }
    if let Some(hex) = base.strip_prefix('u')
        && (4..=6).contains(&hex.len())
        && hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return u32::from_str_radix(hex, 16)
            .ok()
            .and_then(char::from_u32)
            .map(String::from);
    }
    None
}

/// Characters of StandardEncoding from 0x80 up (0x20 to 0x7E are ASCII
/// except two quotes, handled in [`standard_encoding`]).
const STANDARD_HIGH: &[(u8, char)] = &[
    (0xA1, '¡'),
    (0xA2, '¢'),
    (0xA3, '£'),
    (0xA4, '⁄'),
    (0xA5, '¥'),
    (0xA6, 'ƒ'),
    (0xA7, '§'),
    (0xA8, '¤'),
    (0xA9, '\''),
    (0xAA, '“'),
    (0xAB, '«'),
    (0xAC, '‹'),
    (0xAD, '›'),
    (0xAE, 'ﬁ'),
    (0xAF, 'ﬂ'),
    (0xB1, '–'),
    (0xB2, '†'),
    (0xB3, '‡'),
    (0xB4, '·'),
    (0xB6, '¶'),
    (0xB7, '•'),
    (0xB8, '‚'),
    (0xB9, '„'),
    (0xBA, '”'),
    (0xBB, '»'),
    (0xBC, '…'),
    (0xBD, '‰'),
    (0xBF, '¿'),
    (0xC1, '`'),
    (0xC2, '´'),
    (0xC3, 'ˆ'),
    (0xC4, '˜'),
    (0xC5, '¯'),
    (0xC6, '˘'),
    (0xC7, '˙'),
    (0xC8, '¨'),
    (0xCA, '˚'),
    (0xCB, '¸'),
    (0xCD, '˝'),
    (0xCE, '˛'),
    (0xCF, 'ˇ'),
    (0xD0, '\u{2014}'),
    (0xE1, 'Æ'),
    (0xE3, 'ª'),
    (0xE8, 'Ł'),
    (0xE9, 'Ø'),
    (0xEA, 'Œ'),
    (0xEB, 'º'),
    (0xF1, 'æ'),
    (0xF5, 'ı'),
    (0xF8, 'ł'),
    (0xF9, 'ø'),
    (0xFA, 'œ'),
    (0xFB, 'ß'),
];

/// A base encoding: the text of each of the 256 single-byte codes.
pub(crate) type CodeTable = Vec<Option<String>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BaseEncoding {
    Standard,
    WinAnsi,
    MacRoman,
}

pub(crate) fn base_table(base: BaseEncoding) -> CodeTable {
    match base {
        BaseEncoding::Standard => standard_encoding(),
        BaseEncoding::WinAnsi => single_byte_table(WINDOWS_1252),
        BaseEncoding::MacRoman => single_byte_table(MACINTOSH),
    }
}

fn standard_encoding() -> CodeTable {
    let mut table: CodeTable = vec![None; 256];
    for code in 0x20u8..0x7F {
        table[usize::from(code)] = Some(char::from(code).to_string());
    }
    table[0x27] = Some("’".to_string());
    table[0x60] = Some("‘".to_string());
    for &(code, c) in STANDARD_HIGH {
        table[usize::from(code)] = Some(c.to_string());
    }
    table
}

fn single_byte_table(encoding: &'static encoding_rs::Encoding) -> CodeTable {
    (0u16..256)
        .map(|code| {
            let byte = [code as u8];
            let (text, _) = encoding.decode_without_bom_handling(&byte);
            let c = text.chars().next()?;
            // Control codes have no glyph; PDF writers map the gaps in
            // WinAnsi (0x81, 0x8D, ...) to nothing useful either.
            if c.is_control() {
                return None;
            }
            Some(text.into_owned())
        })
        .collect()
}

/// Widths (in 1/1000 em) of ASCII 32..=126 in Helvetica, for core fonts
/// used without a /Widths array. Helvetica-Bold and Arial are close enough
/// for deciding where words end.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Widths of ASCII 32..=126 in Times-Roman.
const TIMES: [u16; 95] = [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500,
    500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611,
    556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722,
    722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500,
    278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

/// The width of a single-byte code in one of the 14 core fonts, by base
/// font name. Courier is monospaced; the rest use Helvetica or Times
/// metrics for ASCII and an average elsewhere.
pub(crate) fn core_font_width(base_font: &[u8], code: u8) -> f64 {
    let name = String::from_utf8_lossy(base_font).to_ascii_lowercase();
    if name.contains("courier") || name.contains("mono") {
        return 600.0;
    }
    let table = if name.contains("times") || name.contains("serif") && !name.contains("sans") {
        &TIMES
    } else {
        &HELVETICA
    };
    match code {
        32..=126 => f64::from(table[usize::from(code - 32)]),
        _ => 500.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_glyph_table_is_sorted() {
        assert!(GLYPHS.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn glyph_names() {
        assert_eq!(glyph_to_text(b"eacute").as_deref(), Some("é"));
        assert_eq!(glyph_to_text(b"uni20AC").as_deref(), Some("€"));
        assert_eq!(glyph_to_text(b"uni00660069").as_deref(), Some("fi"));
        assert_eq!(glyph_to_text(b"u1F600").as_deref(), Some("😀"));
        assert_eq!(glyph_to_text(b"a.sc").as_deref(), Some("a"));
        assert_eq!(glyph_to_text(b"f_f_i").as_deref(), Some("ffi"));
        assert_eq!(glyph_to_text(b"g123"), None);
        assert_eq!(glyph_to_text(b""), None);
        assert_eq!(glyph_to_text(b".notdef"), None);
    }

    #[test]
    fn base_encodings() {
        let win = base_table(BaseEncoding::WinAnsi);
        assert_eq!(win[0x80].as_deref(), Some("€"));
        assert_eq!(win[0xE9].as_deref(), Some("é"));
        assert_eq!(win[0x0A], None);
        let std = base_table(BaseEncoding::Standard);
        assert_eq!(std[0x41].as_deref(), Some("A"));
        assert_eq!(std[0x27].as_deref(), Some("’"));
        assert_eq!(std[0xFB].as_deref(), Some("ß"));
        let mac = base_table(BaseEncoding::MacRoman);
        assert_eq!(mac[0x8E].as_deref(), Some("é"));
    }
}
