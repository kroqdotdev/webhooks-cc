//! PDF text extraction: the text layer only, no OCR.
//!
//! lopdf parses the file structure (cross-reference tables, object streams,
//! decryption with an empty password) with a cap on every decompression.
//! Everything after that is ours: a lenient content-stream tokenizer, font
//! decoding, and a small interpreter that follows the text operators and
//! places a space or a line break between runs by their positions.
//!
//! Hostile files are bounded by budgets shared across the document: bytes
//! decompressed, operators interpreted and text produced. Form XObjects nest
//! at most a few levels and never into themselves. A page that panics
//! inside a library yields no text instead of failing the document.

mod cmap;
mod font;
mod glyphs;
mod lexer;

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;

use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, Stream};

use crate::output::{ErrorCode, Failure};
use font::{Font, Glyph};
use lexer::{Operand, Operations};

/// Most bytes one stream may decompress to.
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
/// Most bytes an object or cross-reference stream may decompress to while
/// the file loads. lopdf parses them eagerly into objects several times
/// their size, and real ones are a few hundred KiB.
const MAX_LOAD_STREAM_BYTES: usize = 16 * 1024 * 1024;
/// Most bytes decompressed for text extraction across the document.
const MAX_DECODED_BYTES: usize = 256 * 1024 * 1024;
/// Most content stream operators interpreted across the document.
const MAX_OPERATIONS: u64 = 5_000_000;
/// Most text produced across the document.
pub(crate) const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;
/// How deep Form XObjects may nest.
const MAX_FORM_DEPTH: usize = 12;
/// How deep the graphics state stack may grow.
const MAX_STATE_DEPTH: usize = 256;
/// How many parents a page may inherit resources through.
const MAX_INHERITANCE: usize = 32;
/// How many references are followed to reach an object.
const MAX_DEREF: usize = 16;

#[derive(Debug)]
pub(crate) struct PdfText {
    pub pages: Vec<String>,
    pub truncated: bool,
}

pub(crate) fn parse(input: &[u8], max_pages: u64) -> Result<PdfText, Failure> {
    let doc = load(input)?;
    let mut extractor = Extractor::new(&doc);
    let mut pages = Vec::new();
    let mut truncated = false;
    for (index, page_id) in doc.page_iter().enumerate() {
        if index as u64 >= max_pages {
            truncated = true;
            break;
        }
        let text =
            catch_unwind(AssertUnwindSafe(|| extractor.page_text(page_id))).unwrap_or_default();
        pages.push(text);
        if extractor.budget.exhausted {
            truncated = true;
            break;
        }
    }
    if pages.is_empty() && !truncated {
        return Err(Failure::new(ErrorCode::Empty, "the PDF has no pages"));
    }
    if !truncated && pages.iter().all(|p| p.trim().is_empty()) {
        return Err(Failure::new(
            ErrorCode::Empty,
            "the PDF has no text layer (scanned pages need OCR)",
        ));
    }
    Ok(PdfText { pages, truncated })
}

fn load(input: &[u8]) -> Result<Document, Failure> {
    const ENCRYPTED: Failure = Failure::new(ErrorCode::Encrypted, "the PDF needs a password");
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_LOAD_STREAM_BYTES),
        ..LoadOptions::default()
    };
    match Document::load_mem_with_options(input, options) {
        // lopdf decrypts with the empty user password when that works (owner
        // restrictions only); when it does not, the Encrypt entry stays.
        Ok(doc) if doc.is_encrypted() => Err(ENCRYPTED),
        Ok(doc) => Ok(doc),
        Err(lopdf::Error::InvalidPassword | lopdf::Error::Decryption(_)) => Err(ENCRYPTED),
        Err(_) => Err(Failure::malformed("the file is not a readable PDF")),
    }
}

/// Budgets shared by every page of one document.
pub(crate) struct Budget {
    decoded: usize,
    operations: u64,
    text: usize,
    /// Set once any budget runs out; extraction stops and the output is
    /// marked truncated.
    exhausted: bool,
}

impl Budget {
    /// Decodes a stream's filters within both the per-stream cap and what
    /// is left of the document budget.
    pub(crate) fn decode(&mut self, stream: &Stream, cap: usize) -> Option<Vec<u8>> {
        let left = MAX_DECODED_BYTES.saturating_sub(self.decoded);
        if left == 0 {
            self.exhausted = true;
            return None;
        }
        let limit = cap.min(MAX_STREAM_BYTES).min(left);
        match stream.decompressed_content_with_limit(limit) {
            Ok(data) => {
                self.decoded += data.len();
                Some(data)
            }
            Err(lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded {
                ..
            })) => {
                if limit == left {
                    self.exhausted = true;
                }
                None
            }
            Err(_) => None,
        }
    }
}

// Small helpers over lopdf objects that follow references a bounded number
// of times and never panic.

pub(crate) fn resolve<'a>(doc: &'a Document, mut obj: Option<&'a Object>) -> Option<&'a Object> {
    for _ in 0..MAX_DEREF {
        match obj? {
            Object::Reference(id) => obj = doc.objects.get(id),
            other => return Some(other),
        }
    }
    None
}

pub(crate) fn dict_of<'a>(doc: &'a Document, obj: Option<&'a Object>) -> Option<&'a Dictionary> {
    match resolve(doc, obj)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

pub(crate) fn array_of<'a>(doc: &'a Document, obj: Option<&'a Object>) -> Option<&'a Vec<Object>> {
    match resolve(doc, obj)? {
        Object::Array(a) => Some(a),
        _ => None,
    }
}

pub(crate) fn name_of(doc: &Document, obj: Option<&Object>) -> Option<Vec<u8>> {
    match resolve(doc, obj)? {
        Object::Name(n) => Some(n.clone()),
        _ => None,
    }
}

pub(crate) fn number_of(doc: &Document, obj: Option<&Object>) -> Option<f64> {
    match resolve(doc, obj)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)).filter(|v| v.is_finite()),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

const IDENTITY: Matrix = Matrix {
    a: 1.0,
    b: 0.0,
    c: 0.0,
    d: 1.0,
    e: 0.0,
    f: 0.0,
};

impl Matrix {
    fn translate(x: f64, y: f64) -> Matrix {
        Matrix {
            e: x,
            f: y,
            ..IDENTITY
        }
    }

    /// `self` applied first, then `other` (PDF's row-vector convention).
    fn then(self, o: Matrix) -> Matrix {
        Matrix {
            a: self.a * o.a + self.b * o.c,
            b: self.a * o.b + self.b * o.d,
            c: self.c * o.a + self.d * o.c,
            d: self.c * o.b + self.d * o.d,
            e: self.e * o.a + self.f * o.c + o.e,
            f: self.e * o.b + self.f * o.d + o.f,
        }
    }

    fn apply(self, x: f64, y: f64) -> (f64, f64) {
        (
            x * self.a + y * self.c + self.e,
            x * self.b + y * self.d + self.f,
        )
    }

    fn from_numbers(v: &[f64]) -> Option<Matrix> {
        let m = Matrix {
            a: *v.first()?,
            b: *v.get(1)?,
            c: *v.get(2)?,
            d: *v.get(3)?,
            e: *v.get(4)?,
            f: *v.get(5)?,
        };
        [m.a, m.b, m.c, m.d, m.e, m.f]
            .iter()
            .all(|x| x.is_finite())
            .then_some(m)
    }
}

#[derive(Clone)]
struct GraphicsState {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    font_size: f64,
    char_spacing: f64,
    word_spacing: f64,
    horizontal_scale: f64,
    leading: f64,
    rise: f64,
}

impl Default for GraphicsState {
    fn default() -> Self {
        Self {
            ctm: IDENTITY,
            font: None,
            font_size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            horizontal_scale: 1.0,
            leading: 0.0,
            rise: 0.0,
        }
    }
}

struct State {
    gs: GraphicsState,
    stack: Vec<GraphicsState>,
    tm: Matrix,
    tlm: Matrix,
}

struct Extractor<'d> {
    doc: &'d Document,
    budget: Budget,
    fonts: HashMap<ObjectId, Rc<Font>>,
    /// Fonts written inline in a resource dictionary, keyed by that
    /// dictionary's address and the font's name.
    inline_fonts: HashMap<(usize, Vec<u8>), Rc<Font>>,
    forms: HashMap<ObjectId, Rc<Vec<u8>>>,
}

impl<'d> Extractor<'d> {
    fn new(doc: &'d Document) -> Self {
        Self {
            doc,
            budget: Budget {
                decoded: 0,
                operations: 0,
                text: 0,
                exhausted: false,
            },
            fonts: HashMap::new(),
            inline_fonts: HashMap::new(),
            forms: HashMap::new(),
        }
    }

    fn page_text(&mut self, page_id: ObjectId) -> String {
        let doc = self.doc;
        let Some(Object::Dictionary(page)) = doc.objects.get(&page_id) else {
            return String::new();
        };
        let resources = inherited(doc, page, b"Resources").and_then(|o| dict_of(doc, Some(o)));
        let mut content = Vec::new();
        for id in doc.get_page_contents(page_id) {
            let Some(Object::Stream(stream)) = doc.objects.get(&id) else {
                continue;
            };
            if let Some(data) = self.budget.decode(stream, MAX_STREAM_BYTES) {
                content.extend_from_slice(&data);
                // Operators may not span streams, but the last token of one
                // must not run into the first of the next.
                content.push(b'\n');
            }
        }
        self.content_text(&content, resources)
    }

    /// The text of one page's content stream.
    fn content_text(&mut self, content: &[u8], resources: Option<&'d Dictionary>) -> String {
        let mut state = State {
            gs: GraphicsState::default(),
            stack: Vec::new(),
            tm: IDENTITY,
            tlm: IDENTITY,
        };
        let mut sink = Sink::default();
        let mut forms = Vec::new();
        self.run(content, resources, &mut state, &mut sink, &mut forms);
        let text = sink.finish();
        self.budget.text += text.len();
        text
    }

    fn run(
        &mut self,
        content: &[u8],
        resources: Option<&'d Dictionary>,
        st: &mut State,
        sink: &mut Sink,
        forms: &mut Vec<ObjectId>,
    ) {
        for op in Operations::new(content) {
            self.budget.operations += 1;
            if self.budget.operations > MAX_OPERATIONS || self.budget.exhausted {
                self.budget.exhausted = true;
                return;
            }
            let nums = numbers(&op.operands);
            match op.op {
                b"q" => {
                    if st.stack.len() < MAX_STATE_DEPTH {
                        st.stack.push(st.gs.clone());
                    }
                }
                b"Q" => {
                    if let Some(gs) = st.stack.pop() {
                        st.gs = gs;
                    }
                }
                b"cm" => {
                    if let Some(m) = last_matrix(&nums) {
                        st.gs.ctm = m.then(st.gs.ctm);
                    }
                }
                b"BT" => {
                    st.tm = IDENTITY;
                    st.tlm = IDENTITY;
                }
                b"Tf" => {
                    if let Some(&size) = nums.last() {
                        st.gs.font_size = size;
                    }
                    if let Some(name) = op.operands.iter().rev().find_map(|o| match o {
                        Operand::Name(n) => Some(n),
                        _ => None,
                    }) {
                        st.gs.font = self.font(resources, name);
                    }
                }
                b"Tc" => set_last(&nums, &mut st.gs.char_spacing),
                b"Tw" => set_last(&nums, &mut st.gs.word_spacing),
                b"Tz" => {
                    if let Some(&v) = nums.last() {
                        st.gs.horizontal_scale = v / 100.0;
                    }
                }
                b"TL" => set_last(&nums, &mut st.gs.leading),
                b"Ts" => set_last(&nums, &mut st.gs.rise),
                b"Td" | b"TD" => {
                    if let [.., tx, ty] = nums[..] {
                        if op.op == b"TD" {
                            st.gs.leading = -ty;
                        }
                        st.tlm = Matrix::translate(tx, ty).then(st.tlm);
                        st.tm = st.tlm;
                    }
                }
                b"Tm" => {
                    if let Some(m) = last_matrix(&nums) {
                        st.tlm = m;
                        st.tm = m;
                    }
                }
                b"T*" => next_line(st),
                b"Tj" => {
                    if let Some(Operand::Str(s)) = op.operands.last() {
                        self.show(s, st, sink);
                    }
                }
                b"'" => {
                    next_line(st);
                    if let Some(Operand::Str(s)) = op.operands.last() {
                        self.show(s, st, sink);
                    }
                }
                b"\"" => {
                    if let [.., aw, ac] = nums[..] {
                        st.gs.word_spacing = aw;
                        st.gs.char_spacing = ac;
                    }
                    next_line(st);
                    if let Some(Operand::Str(s)) = op.operands.last() {
                        self.show(s, st, sink);
                    }
                }
                b"TJ" => {
                    if let Some(Operand::Array(items)) = op.operands.last() {
                        for item in items {
                            match item {
                                Operand::Str(s) => self.show(s, st, sink),
                                Operand::Number(n) => {
                                    let tx = -n / 1000.0 * st.gs.font_size * st.gs.horizontal_scale;
                                    st.tm = Matrix::translate(tx, 0.0).then(st.tm);
                                }
                                _ => {}
                            }
                        }
                    }
                }
                b"Do" => {
                    if let Some(Operand::Name(name)) = op.operands.last() {
                        self.form(name, resources, st, sink, forms);
                    }
                }
                _ => {}
            }
            if sink.text_len() > MAX_TEXT_BYTES.saturating_sub(self.budget.text) {
                self.budget.exhausted = true;
                return;
            }
        }
    }

    fn show(&mut self, bytes: &[u8], st: &mut State, sink: &mut Sink) {
        let Some(font) = st.gs.font.clone() else {
            return;
        };
        let gs = &st.gs;
        let mut text = String::new();
        let mut advance = 0.0f64;
        font.decode(bytes, &mut |g: Glyph<'_>| {
            text.extend(g.text.chars().filter(|c| !c.is_control() || *c == '\t'));
            let spacing = gs.char_spacing + if g.is_space { gs.word_spacing } else { 0.0 };
            advance += (g.width * gs.font_size + spacing) * gs.horizontal_scale;
        });
        if !advance.is_finite() {
            advance = 0.0;
        }
        let rendering = st.tm.then(gs.ctm);
        let start = rendering.apply(0.0, gs.rise);
        let end = rendering.apply(advance, gs.rise);
        // The font size in device space, from the area scale of the text
        // rendering matrix.
        let det = (rendering.a * rendering.d - rendering.b * rendering.c).abs();
        let size = (gs.font_size.abs() * det.sqrt()).max(1e-6);
        let direction = {
            let len = rendering.a.hypot(rendering.b);
            if len > 0.0 && len.is_finite() {
                (rendering.a / len, rendering.b / len)
            } else {
                (1.0, 0.0)
            }
        };
        sink.run(start, end, direction, size, &text);
        st.tm = Matrix::translate(advance, 0.0).then(st.tm);
    }

    fn font(&mut self, resources: Option<&'d Dictionary>, name: &[u8]) -> Option<Rc<Font>> {
        let doc = self.doc;
        let fonts = dict_of(doc, resources?.get(b"Font").ok())?;
        let entry = fonts.get(name).ok()?;
        if let Object::Reference(id) = entry {
            if let Some(font) = self.fonts.get(id) {
                return Some(font.clone());
            }
            let dict = dict_of(doc, Some(entry))?;
            let font = Rc::new(Font::load(doc, dict, &mut self.budget));
            self.fonts.insert(*id, font.clone());
            return Some(font);
        }
        let dict = dict_of(doc, Some(entry))?;
        let key = (fonts as *const Dictionary as usize, name.to_vec());
        if let Some(font) = self.inline_fonts.get(&key) {
            return Some(font.clone());
        }
        let font = Rc::new(Font::load(doc, dict, &mut self.budget));
        self.inline_fonts.insert(key, font.clone());
        Some(font)
    }

    /// Runs a Form XObject's content with its own matrix and resources.
    /// Images and other XObjects carry no text and are ignored.
    fn form(
        &mut self,
        name: &[u8],
        resources: Option<&'d Dictionary>,
        st: &mut State,
        sink: &mut Sink,
        forms: &mut Vec<ObjectId>,
    ) {
        let doc = self.doc;
        if forms.len() >= MAX_FORM_DEPTH {
            return;
        }
        let Some(xobjects) = resources.and_then(|r| dict_of(doc, r.get(b"XObject").ok())) else {
            return;
        };
        let Ok(Object::Reference(id)) = xobjects.get(name) else {
            return;
        };
        if forms.contains(id) {
            return;
        }
        let Some(Object::Stream(stream)) = doc.objects.get(id) else {
            return;
        };
        if name_of(doc, stream.dict.get(b"Subtype").ok()).as_deref() != Some(b"Form") {
            return;
        }
        let content = match self.forms.get(id) {
            Some(c) => c.clone(),
            None => {
                let decoded = Rc::new(
                    self.budget
                        .decode(stream, MAX_STREAM_BYTES)
                        .unwrap_or_default(),
                );
                self.forms.insert(*id, decoded.clone());
                decoded
            }
        };
        let form_resources = dict_of(doc, stream.dict.get(b"Resources").ok()).or(resources);
        let matrix = array_of(doc, stream.dict.get(b"Matrix").ok())
            .map(|m| {
                m.iter()
                    .filter_map(|v| number_of(doc, Some(v)))
                    .collect::<Vec<_>>()
            })
            .and_then(|v| Matrix::from_numbers(&v))
            .unwrap_or(IDENTITY);
        let saved_gs = st.gs.clone();
        let saved_depth = st.stack.len();
        let (saved_tm, saved_tlm) = (st.tm, st.tlm);
        st.gs.ctm = matrix.then(st.gs.ctm);
        forms.push(*id);
        self.run(&content, form_resources, st, sink, forms);
        forms.pop();
        st.gs = saved_gs;
        st.stack.truncate(saved_depth);
        st.tm = saved_tm;
        st.tlm = saved_tlm;
    }
}

fn numbers(operands: &[Operand]) -> Vec<f64> {
    operands
        .iter()
        .filter_map(|o| match o {
            Operand::Number(n) => Some(*n),
            _ => None,
        })
        .collect()
}

fn set_last(nums: &[f64], slot: &mut f64) {
    if let Some(&v) = nums.last() {
        *slot = v;
    }
}

fn last_matrix(nums: &[f64]) -> Option<Matrix> {
    let start = nums.len().checked_sub(6)?;
    Matrix::from_numbers(&nums[start..])
}

fn next_line(st: &mut State) {
    st.tlm = Matrix::translate(0.0, -st.gs.leading).then(st.tlm);
    st.tm = st.tlm;
}

/// A page attribute, looked up on the page and then its ancestors.
fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    let mut node = page;
    for _ in 0..MAX_INHERITANCE {
        if let Ok(value) = node.get(key) {
            return Some(value);
        }
        node = dict_of(doc, node.get(b"Parent").ok())?;
    }
    None
}

/// Assembles runs of text into lines. A run that starts on a different
/// baseline begins a new line; a run that starts clearly after the previous
/// one ended on the same line gets a space before it.
#[derive(Default)]
struct Sink {
    out: String,
    last: Option<LastRun>,
}

struct LastRun {
    end_along: f64,
    across: f64,
    size: f64,
    direction: (f64, f64),
}

impl Sink {
    fn text_len(&self) -> usize {
        self.out.len()
    }

    fn run(
        &mut self,
        start: (f64, f64),
        end: (f64, f64),
        direction: (f64, f64),
        size: f64,
        text: &str,
    ) {
        let along = |p: (f64, f64)| p.0 * direction.0 + p.1 * direction.1;
        let across = |p: (f64, f64)| p.1 * direction.0 - p.0 * direction.1;
        if text.is_empty() {
            // Nothing to show, but the pen moved: remember where it ended so
            // the next word is spaced from it correctly.
            if let Some(last) = self.last.as_mut() {
                last.end_along = along(end);
            }
            return;
        }
        if let Some(last) = &self.last {
            let same_direction =
                direction.0 * last.direction.0 + direction.1 * last.direction.1 > 0.99;
            let scale = size.max(last.size);
            // NaN (from a degenerate matrix) counts as a different line.
            let same_line = (across(start) - last.across).abs() <= scale * 0.5;
            if !same_direction || !same_line {
                self.newline();
            } else {
                let gap = along(start) - last.end_along;
                // A clear gap, or a jump back to the left on the same line
                // (columns written out of order), separates words.
                if (gap > scale * 0.15 || gap < -scale * 3.0)
                    && !self.out.ends_with(char::is_whitespace)
                    && !text.starts_with(char::is_whitespace)
                {
                    self.out.push(' ');
                }
            }
        }
        self.out.push_str(text);
        self.last = Some(LastRun {
            end_along: along(end),
            across: across(start),
            size,
            direction,
        });
    }

    fn newline(&mut self) {
        while self.out.ends_with(' ') {
            self.out.pop();
        }
        if !self.out.is_empty() && !self.out.ends_with('\n') {
            self.out.push('\n');
        }
    }

    /// The page's text with trailing spaces on each line and blank lines at
    /// either end removed.
    fn finish(self) -> String {
        let lines: Vec<&str> = self.out.lines().map(str::trim_end).collect();
        let text = lines.join("\n");
        text.trim_matches('\n').to_string()
    }
}

/// Interprets `content` as a page's content stream against a small fixed
/// document: a simple font with Differences, a composite font with a
/// ToUnicode map, a Type 3 font and a form that draws itself. The fuzz
/// target uses it to reach the interpreter without building a whole PDF.
pub(crate) fn interpret_content(content: &[u8]) -> String {
    use lopdf::dictionary;

    let mut doc = Document::with_version("1.5");
    let simple = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => dictionary! {
            "BaseEncoding" => "WinAnsiEncoding",
            "Differences" => vec![65.into(), Object::Name(b"eacute".to_vec()), Object::Name(b"f_i".to_vec())],
        },
    });
    let cmap = doc.add_object(Stream::new(
        Dictionary::new(),
        b"begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange \
          beginbfchar <01> <0041> <8001> <00E9> endbfchar \
          beginbfrange <10> <20> <0061> <8100> <8102> [<0031> <0032> <0033>] endbfrange"
            .to_vec(),
    ));
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "DW" => 800,
        "W" => vec![1.into(), vec![500.into(), 600.into()].into(), 10.into(), 20.into(), 300.into()],
    });
    let composite = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant.into()],
        "ToUnicode" => cmap,
    });
    let type3 = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type3",
        "FontMatrix" => vec![0.01.into(), 0.into(), 0.into(), 0.01.into(), 0.into(), 0.into()],
        "FirstChar" => 32,
        "Widths" => vec![25.into(), 50.into(), 75.into()],
    });
    let form = doc.new_object_id();
    let resources = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => simple, "F2" => composite, "F3" => type3 },
        "XObject" => dictionary! { "X1" => form },
    });
    doc.objects.insert(
        form,
        Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 10.into(), 10.into()],
                "Resources" => resources,
            },
            b"BT /F1 9 Tf (form) Tj ET /X1 Do".to_vec(),
        )),
    );
    let mut extractor = Extractor::new(&doc);
    let resources = dict_of(&doc, doc.objects.get(&resources));
    extractor.content_text(content, resources)
}

/// Parses `data` as a CMap and looks codes from it up, for the fuzz target.
pub(crate) fn probe_cmap(data: &[u8]) -> usize {
    let cmap = cmap::CMap::parse(data);
    let mut found = 0;
    let mut i = 0;
    while i < data.len() {
        let len = cmap.code_len(&data[i..]).min(data.len() - i);
        let code = data[i..i + len]
            .iter()
            .fold(0u32, |acc, &b| acc << 8 | u32::from(b));
        found += cmap.lookup(len as u8, code).map_or(0, |s| s.len());
        i += len;
    }
    found
}

#[cfg(test)]
pub(crate) mod tests;
