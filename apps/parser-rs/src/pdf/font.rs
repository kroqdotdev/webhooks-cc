//! Fonts: turning the bytes of a shown string into text and advance widths.
//!
//! The order of preference for text is the font's ToUnicode map, then its
//! encoding (a base encoding plus Differences glyph names), then for
//! composite fonts a predefined Unicode or legacy CJK CMap. Widths come from
//! /Widths or /W, falling back to core font metrics, so the extractor can
//! tell where one word ends and the next begins.

use encoding_rs::{BIG5, EUC_JP, EUC_KR, Encoding, GBK, SHIFT_JIS};
use lopdf::{Dictionary, Document, Object};

use super::cmap::CMap;
use super::glyphs::{BaseEncoding, CodeTable, base_table, core_font_width, glyph_to_text};
use super::{Budget, array_of, dict_of, name_of, number_of, resolve};

/// Entries kept from a /Widths or /W array.
const MAX_WIDTH_ENTRIES: usize = 1 << 20;
/// Bytes a ToUnicode or encoding CMap may decompress to.
const MAX_CMAP_BYTES: usize = 8 * 1024 * 1024;

pub(crate) struct Font {
    to_unicode: Option<CMap>,
    kind: Kind,
    /// Glyph space to text space: 1/1000 for every font but Type 3.
    scale: f64,
}

enum Kind {
    Simple {
        table: CodeTable,
        widths: SimpleWidths,
    },
    Composite {
        codes: CodeSpace,
        widths: CidWidths,
    },
}

enum SimpleWidths {
    Listed {
        first: u32,
        widths: Vec<f64>,
        missing: f64,
    },
    Core(Vec<u8>),
}

enum CodeSpace {
    /// Two-byte codes that are the CIDs themselves (Identity-H/V).
    Identity,
    /// Two-byte UCS-2 or UTF-16 codes (UniJIS-UCS2-H and friends).
    Unicode,
    /// A legacy multi-byte encoding (Shift-JIS, GBK, Big5, EUC).
    Legacy(&'static Encoding),
    /// Code lengths from an embedded CMap's code space ranges.
    Embedded(CMap),
}

struct CidWidths {
    default: f64,
    /// (first CID, widths of consecutive CIDs), sorted by first CID.
    runs: Vec<(u32, Vec<f64>)>,
    /// (first, last, width), sorted by first.
    spans: Vec<(u32, u32, f64)>,
}

impl CidWidths {
    fn get(&self, cid: u32) -> f64 {
        let i = self.runs.partition_point(|(first, _)| *first <= cid);
        if let Some((first, widths)) = i.checked_sub(1).and_then(|i| self.runs.get(i))
            && let Some(&w) = widths.get((cid - first) as usize)
        {
            return w;
        }
        let i = self.spans.partition_point(|(first, _, _)| *first <= cid);
        if let Some(&(_, last, w)) = i.checked_sub(1).and_then(|i| self.spans.get(i))
            && cid <= last
        {
            return w;
        }
        self.default
    }
}

/// One decoded character code.
pub(crate) struct Glyph<'t> {
    pub text: &'t str,
    /// Advance in text space for a font size of 1.
    pub width: f64,
    /// A single-byte code 32, to which word spacing applies.
    pub is_space: bool,
}

impl Font {
    pub(crate) fn load(doc: &Document, font: &Dictionary, budget: &mut Budget) -> Font {
        let to_unicode = resolve(doc, font.get(b"ToUnicode").ok())
            .and_then(|o| o.as_stream().ok())
            .and_then(|s| budget.decode(s, MAX_CMAP_BYTES))
            .map(|data| CMap::parse(&data))
            .filter(|c| !c.is_empty());
        let subtype = name_of(doc, font.get(b"Subtype").ok()).unwrap_or_default();
        if subtype == b"Type0" {
            return Font {
                to_unicode,
                kind: Kind::Composite {
                    codes: composite_codes(doc, font, budget),
                    widths: cid_widths(doc, font),
                },
                scale: 0.001,
            };
        }
        let scale = if subtype == b"Type3" {
            array_of(doc, font.get(b"FontMatrix").ok())
                .and_then(|m| m.first().and_then(|v| number_of(doc, Some(v))))
                .filter(|v| v.is_finite() && *v != 0.0)
                .unwrap_or(0.001)
        } else {
            0.001
        };
        Font {
            to_unicode,
            kind: Kind::Simple {
                table: simple_table(doc, font, &subtype),
                widths: simple_widths(doc, font, scale),
            },
            scale,
        }
    }

    /// Calls `f` for every character code in `bytes`.
    pub(crate) fn decode(&self, bytes: &[u8], f: &mut dyn FnMut(Glyph<'_>)) {
        match &self.kind {
            Kind::Simple { table, widths } => {
                for &b in bytes {
                    let mapped = self
                        .to_unicode
                        .as_ref()
                        .and_then(|m| m.lookup(1, u32::from(b)));
                    let text = match &mapped {
                        Some(t) => t.as_str(),
                        None => table[usize::from(b)].as_deref().unwrap_or(""),
                    };
                    let width = match widths {
                        SimpleWidths::Listed {
                            first,
                            widths,
                            missing,
                        } => u32::from(b)
                            .checked_sub(*first)
                            .and_then(|i| widths.get(i as usize))
                            .copied()
                            .unwrap_or(*missing),
                        SimpleWidths::Core(name) => core_font_width(name, b),
                    };
                    f(Glyph {
                        text,
                        width: width * self.scale,
                        is_space: b == b' ',
                    });
                }
            }
            Kind::Composite { codes, widths } => {
                if let CodeSpace::Legacy(encoding) = codes
                    && self.to_unicode.is_none()
                {
                    // Widths of legacy CJK codes go through CIDs we do not
                    // map; a full-width advance per character is close.
                    let (text, _) = encoding.decode_without_bom_handling(bytes);
                    let mut tmp = [0u8; 4];
                    for c in text.chars() {
                        let w = if c.is_ascii() { 500.0 } else { widths.default };
                        f(Glyph {
                            text: c.encode_utf8(&mut tmp),
                            width: w * self.scale,
                            is_space: false,
                        });
                    }
                    return;
                }
                let mut i = 0;
                while i < bytes.len() {
                    let len = match codes {
                        CodeSpace::Embedded(cmap) => cmap.code_len(&bytes[i..]),
                        CodeSpace::Legacy(_) => self
                            .to_unicode
                            .as_ref()
                            .filter(|m| m.has_codespace())
                            .map_or(2, |m| m.code_len(&bytes[i..])),
                        CodeSpace::Identity | CodeSpace::Unicode => 2,
                    }
                    .min(bytes.len() - i);
                    let code = bytes[i..i + len]
                        .iter()
                        .fold(0u32, |acc, &b| acc << 8 | u32::from(b));
                    i += len;
                    let mapped = self
                        .to_unicode
                        .as_ref()
                        .and_then(|m| m.lookup(len as u8, code));
                    let fallback;
                    let text = match (&mapped, codes) {
                        (Some(t), _) => t.as_str(),
                        (None, CodeSpace::Unicode) => {
                            fallback = char::from_u32(code)
                                .filter(|c| !c.is_control())
                                .map(String::from)
                                .unwrap_or_default();
                            fallback.as_str()
                        }
                        _ => "",
                    };
                    // For Identity encodings the code is the CID; for the
                    // rest we do not map codes to CIDs and use the default.
                    let width = match codes {
                        CodeSpace::Identity => widths.get(code),
                        _ => widths.default,
                    };
                    f(Glyph {
                        text,
                        width: width * self.scale,
                        is_space: len == 1 && code == 32,
                    });
                }
            }
        }
    }
}

fn composite_codes(doc: &Document, font: &Dictionary, budget: &mut Budget) -> CodeSpace {
    let encoding = resolve(doc, font.get(b"Encoding").ok());
    match encoding {
        Some(Object::Name(name)) => {
            let name = String::from_utf8_lossy(name);
            if name.starts_with("Identity") {
                CodeSpace::Identity
            } else if name.contains("UCS2") || name.contains("UTF16") {
                CodeSpace::Unicode
            } else if name.contains("RKSJ") {
                CodeSpace::Legacy(SHIFT_JIS)
            } else if name.contains("GB") {
                CodeSpace::Legacy(GBK)
            } else if name.contains("KSC") {
                CodeSpace::Legacy(EUC_KR)
            } else if name.contains("B5") || name.contains("ETen") || name.contains("HKscs") {
                CodeSpace::Legacy(BIG5)
            } else if name.contains("EUC") {
                CodeSpace::Legacy(EUC_JP)
            } else {
                CodeSpace::Identity
            }
        }
        Some(Object::Stream(stream)) => {
            let cmap = budget
                .decode(stream, MAX_CMAP_BYTES)
                .map(|data| CMap::parse(&data))
                .filter(CMap::has_codespace);
            match cmap {
                Some(cmap) => CodeSpace::Embedded(cmap),
                None => CodeSpace::Identity,
            }
        }
        _ => CodeSpace::Identity,
    }
}

fn cid_widths(doc: &Document, font: &Dictionary) -> CidWidths {
    let mut widths = CidWidths {
        default: 1000.0,
        runs: Vec::new(),
        spans: Vec::new(),
    };
    let Some(descendant) = array_of(doc, font.get(b"DescendantFonts").ok())
        .and_then(|a| a.first())
        .and_then(|d| dict_of(doc, Some(d)))
    else {
        return widths;
    };
    if let Some(dw) = number_of(doc, descendant.get(b"DW").ok()).filter(|v| v.is_finite()) {
        widths.default = dw;
    }
    let Some(w) = array_of(doc, descendant.get(b"W").ok()) else {
        return widths;
    };
    let mut entries = 0usize;
    let mut i = 0;
    while i < w.len() && entries < MAX_WIDTH_ENTRIES {
        let Some(first) = number_of(doc, Some(&w[i])) else {
            break;
        };
        let first = first.max(0.0) as u32;
        if let Some(list) = w.get(i + 1).and_then(|o| array_of(doc, Some(o))) {
            let run: Vec<f64> = list
                .iter()
                .take(MAX_WIDTH_ENTRIES - entries)
                .map(|v| number_of(doc, Some(v)).unwrap_or(widths.default))
                .collect();
            entries += run.len().max(1);
            widths.runs.push((first, run));
            i += 2;
        } else if let (Some(last), Some(width)) = (
            w.get(i + 1).and_then(|o| number_of(doc, Some(o))),
            w.get(i + 2).and_then(|o| number_of(doc, Some(o))),
        ) {
            widths.spans.push((first, last.max(0.0) as u32, width));
            entries += 1;
            i += 3;
        } else {
            break;
        }
    }
    widths.runs.sort_by_key(|(first, _)| *first);
    widths.spans.sort_by_key(|(first, _, _)| *first);
    widths
}

fn simple_widths(doc: &Document, font: &Dictionary, scale: f64) -> SimpleWidths {
    let missing = dict_of(doc, font.get(b"FontDescriptor").ok())
        .and_then(|d| number_of(doc, d.get(b"MissingWidth").ok()))
        .filter(|v| v.is_finite() && *v > 0.0);
    let listed = array_of(doc, font.get(b"Widths").ok()).filter(|w| !w.is_empty());
    match listed {
        Some(list) => {
            let widths: Vec<f64> = list
                .iter()
                .take(256)
                .map(|v| number_of(doc, Some(v)).unwrap_or(0.0))
                .collect();
            let average = {
                let used: Vec<f64> = widths.iter().copied().filter(|w| *w > 0.0).collect();
                if used.is_empty() {
                    // Type 3 widths are in glyph space; 1/2 em either way.
                    0.5 / scale
                } else {
                    used.iter().sum::<f64>() / used.len() as f64
                }
            };
            SimpleWidths::Listed {
                first: number_of(doc, font.get(b"FirstChar").ok())
                    .map_or(0, |v| v.clamp(0.0, 255.0) as u32),
                widths,
                missing: missing.unwrap_or(average),
            }
        }
        None => SimpleWidths::Core(name_of(doc, font.get(b"BaseFont").ok()).unwrap_or_default()),
    }
}

/// The single-byte code table of a simple font: its base encoding with the
/// Differences applied.
fn simple_table(doc: &Document, font: &Dictionary, subtype: &[u8]) -> CodeTable {
    // Without an /Encoding, Type 1 fonts use their built-in encoding, which
    // is almost always StandardEncoding. TrueType fonts without one map
    // codes through the font's own tables, which in practice means ASCII.
    let default = if subtype == b"TrueType" {
        BaseEncoding::WinAnsi
    } else {
        BaseEncoding::Standard
    };
    let base_named = |name: &[u8]| match name {
        b"WinAnsiEncoding" => Some(BaseEncoding::WinAnsi),
        b"MacRomanEncoding" => Some(BaseEncoding::MacRoman),
        b"StandardEncoding" => Some(BaseEncoding::Standard),
        _ => None,
    };
    match resolve(doc, font.get(b"Encoding").ok()) {
        Some(Object::Name(name)) => base_table(base_named(name).unwrap_or(default)),
        Some(Object::Dictionary(enc)) => {
            let base = name_of(doc, enc.get(b"BaseEncoding").ok())
                .and_then(|n| base_named(&n))
                .unwrap_or(default);
            let mut table = base_table(base);
            if let Some(diffs) = array_of(doc, enc.get(b"Differences").ok()) {
                let mut code: Option<usize> = None;
                for item in diffs {
                    match resolve(doc, Some(item)) {
                        Some(Object::Integer(i)) => {
                            code = usize::try_from(*i).ok().filter(|c| *c < 256)
                        }
                        Some(Object::Name(glyph)) => {
                            if let Some(c) = code {
                                table[c] = glyph_to_text(glyph);
                                code = Some(c + 1).filter(|c| *c < 256);
                            }
                        }
                        _ => {}
                    }
                }
            }
            table
        }
        _ => base_table(default),
    }
}
