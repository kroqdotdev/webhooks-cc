//! PDF fixtures are built here, with lopdf for well-formed documents and by
//! hand for the broken and hostile ones.

use std::io::Write;

use lopdf::{
    Dictionary, Document, EncryptionState, EncryptionVersion, Object, ObjectId, Permissions,
    Stream, dictionary,
};

use super::*;

/// A document with one page per content stream. Every page shares one
/// resource dictionary holding a Helvetica font F1 (no /Widths, so core
/// metrics are used) and whatever `extra` adds.
pub(crate) struct Builder {
    pub doc: Document,
    pages_id: ObjectId,
    kids: Vec<Object>,
    pub resources: Dictionary,
}

impl Builder {
    pub(crate) fn new() -> Self {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });
        Self {
            doc,
            pages_id,
            kids: Vec::new(),
            resources: dictionary! { "Font" => dictionary! { "F1" => font } },
        }
    }

    pub(crate) fn font(&mut self, name: &str, font: Dictionary) {
        let id = self.doc.add_object(font);
        if let Ok(Object::Dictionary(fonts)) = self.resources.get_mut(b"Font") {
            fonts.set(name, id);
        }
    }

    pub(crate) fn page(&mut self, content: &[u8]) -> ObjectId {
        let content_id = self
            .doc
            .add_object(Stream::new(dictionary! {}, content.to_vec()));
        let page = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "Contents" => content_id,
        });
        self.kids.push(page.into());
        page
    }

    pub(crate) fn finish(mut self) -> Document {
        let resources = self.doc.add_object(self.resources);
        let count = self.kids.len() as i64;
        self.doc.objects.insert(
            self.pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => self.kids,
                "Count" => count,
                "Resources" => resources,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog = self
            .doc
            .add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
        self.doc.trailer.set("Root", catalog);
        self.doc
    }

    pub(crate) fn bytes(self) -> Vec<u8> {
        save(self.finish())
    }
}

pub(crate) fn save(mut doc: Document) -> Vec<u8> {
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

/// A PDF whose numbered objects are given verbatim; object 1 is the
/// catalog. The cross-reference table is computed.
pub(crate) fn raw_pdf(objects: &[&[u8]]) -> Vec<u8> {
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        writeln!(out, "{} 0 obj", i + 1).unwrap();
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    write!(out, "xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).unwrap();
    for offset in offsets {
        writeln!(out, "{offset:010} 00000 n ").unwrap();
    }
    write!(
        out,
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    )
    .unwrap();
    out
}

fn text_of(pdf: &[u8]) -> Vec<String> {
    parse(pdf, 100).unwrap().pages
}

fn one_page(content: &str) -> String {
    let mut b = Builder::new();
    b.page(content.as_bytes());
    text_of(&b.bytes()).remove(0)
}

#[test]
fn simple_text() {
    assert_eq!(
        one_page("BT /F1 12 Tf 72 712 Td (Hello World) Tj ET"),
        "Hello World"
    );
}

#[test]
fn lines_and_columns() {
    let text = one_page(
        "BT /F1 12 Tf 72 712 Td (Invoice 42) Tj 0 -14 Td (Name) Tj 200 0 Td (Amount) Tj \
         -200 -14 Td (Acme) Tj 200 0 Td (1,250.00) Tj ET",
    );
    assert_eq!(text, "Invoice 42\nName Amount\nAcme 1,250.00");
}

#[test]
fn kerning_is_not_a_space_but_a_wide_gap_is() {
    let text = one_page("BT /F1 12 Tf 72 712 Td [(W) 120 (orld) -3000 (again)] TJ ET");
    assert_eq!(text, "World again");
}

#[test]
fn text_matrix_operators_and_quotes() {
    let text = one_page(
        "BT /F1 10 Tf 14 TL 1 0 0 1 50 700 Tm (first) Tj T* (second) Tj (third) ' 2 1 (fourth) \" ET",
    );
    assert_eq!(text, "first\nsecond\nthird\nfourth");
}

#[test]
fn winansi_and_octal_escapes() {
    assert_eq!(
        one_page("BT /F1 12 Tf 72 712 Td (caf\\351 \\200 5) Tj ET"),
        "café € 5"
    );
}

#[test]
fn text_inside_graphics_state_and_transforms() {
    let text = one_page(
        "q 2 0 0 2 0 0 cm BT /F1 6 Tf 36 356 Td (scaled) Tj ET Q BT /F1 12 Tf 72 600 Td (plain) Tj ET",
    );
    assert_eq!(text, "scaled\nplain");
}

#[test]
fn rotated_text_keeps_its_words() {
    let text = one_page("BT /F1 12 Tf 0 1 -1 0 300 100 Tm (Up) Tj ( the) Tj ( side) Tj ET");
    assert_eq!(text, "Up the side");
}

#[test]
fn differences_and_glyph_names() {
    let mut b = Builder::new();
    b.font(
        "F2",
        dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Custom",
            "Encoding" => dictionary! {
                "Type" => "Encoding",
                "Differences" => vec![65.into(), Object::Name(b"eacute".to_vec()), Object::Name(b"uni20AC".to_vec()), Object::Name(b"f_i".to_vec())],
            },
        },
    );
    b.page(b"BT /F2 12 Tf 72 712 Td (ABCD) Tj ET");
    assert_eq!(text_of(&b.bytes()), ["é€fiD"]);
}

fn to_unicode_cmap() -> Vec<u8> {
    b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0001> <0048> <0002> <00E9> endbfchar
      1 beginbfrange <0010> <0012> <0061> endbfrange
      endcmap end end"
        .to_vec()
}

#[test]
fn composite_fonts_with_to_unicode() {
    let mut b = Builder::new();
    let cmap = b
        .doc
        .add_object(Stream::new(dictionary! {}, to_unicode_cmap()).with_compression(true));
    let descendant = b.doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "Embedded",
        "DW" => 500,
        "W" => vec![1.into(), vec![600.into(), 700.into()].into(), 16.into(), 18.into(), 450.into()],
    });
    b.font(
        "F2",
        dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => "Embedded",
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![descendant.into()],
            "ToUnicode" => cmap,
        },
    );
    b.page(b"BT /F2 12 Tf 72 712 Td <0001 0002 0010 0011 0012 0099> Tj ET");
    assert_eq!(text_of(&b.bytes()), ["Héabc"]);
}

#[test]
fn compressed_content_streams() {
    let mut b = Builder::new();
    let mut stream = Stream::new(
        dictionary! {},
        b"BT /F1 12 Tf 72 712 Td (Compressed) Tj ET".to_vec(),
    );
    stream.compress().unwrap();
    let id = b.doc.add_object(stream);
    let page = b.page(b"");
    if let Ok(Object::Dictionary(p)) = b.doc.get_object_mut(page) {
        p.set("Contents", vec![Object::Reference(id)]);
    }
    assert_eq!(text_of(&b.bytes()), ["Compressed"]);
}

fn form(b: &mut Builder, content: &[u8], resources: Dictionary) -> ObjectId {
    b.doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Resources" => resources,
        },
        content.to_vec(),
    ))
}

#[test]
fn form_xobjects_are_followed() {
    let mut b = Builder::new();
    let fonts = b.resources.get(b"Font").unwrap().clone();
    let x = form(
        &mut b,
        b"BT /F1 12 Tf 0 0 Td (In a form) Tj ET",
        dictionary! { "Font" => fonts },
    );
    b.resources.set("XObject", dictionary! { "X1" => x });
    b.page(b"BT /F1 12 Tf 72 712 Td (Before) Tj ET q 1 0 0 1 72 600 cm /X1 Do Q");
    assert_eq!(text_of(&b.bytes()), ["Before\nIn a form"]);
}

#[test]
fn a_form_that_draws_itself_terminates() {
    let mut b = Builder::new();
    let fonts = b.resources.get(b"Font").unwrap().clone();
    let id = b.doc.new_object_id();
    let stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "Resources" => dictionary! { "Font" => fonts, "XObject" => dictionary! { "Me" => id } },
        },
        b"BT /F1 12 Tf 0 0 Td (loop) Tj ET /Me Do /Me Do".to_vec(),
    );
    b.doc.objects.insert(id, Object::Stream(stream));
    b.resources.set("XObject", dictionary! { "Me" => id });
    b.page(b"/Me Do");
    assert_eq!(text_of(&b.bytes()), ["loop"]);
}

#[test]
fn exponentially_nested_forms_hit_the_operation_budget() {
    // Each level draws the next ten times: 10^12 draws if nothing stopped it.
    let mut b = Builder::new();
    let fonts = b.resources.get(b"Font").unwrap().clone();
    let mut next = form(
        &mut b,
        b"BT /F1 1 Tf (x) Tj ET",
        dictionary! { "Font" => fonts.clone() },
    );
    for _ in 0..12 {
        let calls = b"/N Do ".repeat(10);
        next = form(
            &mut b,
            &calls,
            dictionary! { "Font" => fonts.clone(), "XObject" => dictionary! { "N" => next } },
        );
    }
    b.resources.set("XObject", dictionary! { "N" => next });
    b.page(b"/N Do");
    let started = std::time::Instant::now();
    let doc = parse(&b.bytes(), 100).unwrap();
    assert!(doc.truncated);
    assert!(started.elapsed().as_secs() < 60, "{:?}", started.elapsed());
}

#[test]
fn page_cap_and_page_separator() {
    let mut b = Builder::new();
    for i in 1..=5 {
        b.page(format!("BT /F1 12 Tf 72 712 Td (Page {i}) Tj ET").as_bytes());
    }
    let pdf = b.bytes();
    let all = parse(&pdf, 100).unwrap();
    assert_eq!(all.pages.len(), 5);
    assert!(!all.truncated);
    let capped = parse(&pdf, 3).unwrap();
    assert_eq!(capped.pages, ["Page 1", "Page 2", "Page 3"]);
    assert!(capped.truncated);
    let out = crate::parse(
        crate::Format::Pdf,
        &pdf,
        &crate::Limits {
            max_pages: 2,
            ..Default::default()
        },
    );
    assert_eq!(out.pages, 2);
    assert_eq!(out.text.as_deref(), Some("Page 1\u{c}Page 2"));
    assert!(out.truncated);
}

#[test]
fn pages_without_text_count_but_a_document_without_any_is_empty() {
    let mut b = Builder::new();
    b.page(b"BT /F1 12 Tf 72 712 Td (Cover) Tj ET");
    b.page(b"0 0 100 100 re f");
    let doc = parse(&b.bytes(), 100).unwrap();
    assert_eq!(doc.pages, ["Cover", ""]);
    let mut b = Builder::new();
    b.page(b"q 100 0 0 100 0 0 cm /Im1 Do Q");
    assert_eq!(parse(&b.bytes(), 100).unwrap_err().code, ErrorCode::Empty);
}

fn encrypted(user_password: &str) -> Vec<u8> {
    let mut b = Builder::new();
    b.page(b"BT /F1 12 Tf 72 712 Td (Secret) Tj ET");
    let mut doc = b.finish();
    doc.trailer.set(
        "ID",
        vec![
            Object::string_literal(b"0123456789abcdef".to_vec()),
            Object::string_literal(b"0123456789abcdef".to_vec()),
        ],
    );
    let state = EncryptionState::try_from(EncryptionVersion::V2 {
        document: &doc,
        owner_password: "owner",
        user_password,
        key_length: 128,
        permissions: Permissions::PRINTABLE,
    })
    .unwrap();
    doc.encrypt(&state).unwrap();
    save(doc)
}

#[test]
fn a_user_password_is_encrypted() {
    assert_eq!(
        parse(&encrypted("open sesame"), 100).unwrap_err().code,
        ErrorCode::Encrypted
    );
}

#[test]
fn an_owner_password_alone_still_reads() {
    assert_eq!(text_of(&encrypted("")), ["Secret"]);
}

#[test]
fn garbage_and_truncated_files_are_malformed() {
    assert_eq!(
        parse(b"not a pdf at all", 100).unwrap_err().code,
        ErrorCode::Malformed
    );
    let mut b = Builder::new();
    b.page(b"BT /F1 12 Tf 72 712 Td (Hi) Tj ET");
    let pdf = b.bytes();
    for cut in [10, pdf.len() / 3, pdf.len() / 2] {
        let result = parse(&pdf[..cut], 100);
        assert!(
            result.is_err() || result.is_ok_and(|d| d.pages.len() <= 1),
            "cut at {cut}"
        );
    }
}

#[test]
fn deeply_nested_objects_do_not_overflow_the_stack() {
    let mut deep = b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Junk ".to_vec();
    deep.extend(std::iter::repeat_n(b'[', 200_000));
    deep.extend(std::iter::repeat_n(b']', 200_000));
    deep.extend_from_slice(b" >>");
    let mut content = b"BT /F1 12 Tf 72 712 Td ".to_vec();
    content.extend(std::iter::repeat_n(b'[', 200_000));
    content.extend(std::iter::repeat_n(b']', 200_000));
    content.extend_from_slice(b" TJ (deep) Tj ET");
    let stream = [
        format!("<< /Length {} >>\nstream\n", content.len()).into_bytes(),
        content,
        b"\nendstream".to_vec(),
    ]
    .concat();
    let pdf = raw_pdf(&[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /Resources << /Font << /F1 6 0 R >> >> >>",
        &deep,
        &stream,
        b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    // Whatever lopdf makes of the junk, nothing may crash.
    let _ = parse(&pdf, 100);
}

#[test]
fn cyclic_page_trees_and_parents_terminate() {
    let pdf = raw_pdf(&[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 /Parent 3 0 R >>",
        b"<< /Type /Page /Parent 4 0 R /Contents 5 0 R >>",
        b"<< /Type /Pages /Parent 3 0 R >>",
        b"<< /Length 30 >>\nstream\nBT /F1 12 Tf (cycle) Tj ET  \nendstream",
    ]);
    let _ = parse(&pdf, 100);
}

#[test]
fn a_decompression_bomb_in_the_content_is_cut_off() {
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    let mut z = ZlibEncoder::new(Vec::new(), Compression::fast());
    z.write_all(b"BT /F1 12 Tf 72 712 Td (bomb) Tj ET ")
        .unwrap();
    let zeros = vec![0u8; 1024 * 1024];
    for _ in 0..(MAX_STREAM_BYTES / zeros.len() + 8) {
        z.write_all(&zeros).unwrap();
    }
    let compressed = z.finish().unwrap();
    let stream = [
        format!(
            "<< /Length {} /Filter /FlateDecode >>\nstream\n",
            compressed.len()
        )
        .into_bytes(),
        compressed,
        b"\nendstream".to_vec(),
    ]
    .concat();
    let pdf = raw_pdf(&[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        &stream,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    // The stream is refused, so the only page has no text.
    assert_eq!(parse(&pdf, 100).unwrap_err().code, ErrorCode::Empty);
}

#[test]
fn hand_written_minimal_pdf() {
    let content = b"BT /F1 12 Tf 72 712 Td (Minimal) Tj ET";
    let stream = [
        format!("<< /Length {} >>\nstream\n", content.len()).into_bytes(),
        content.to_vec(),
        b"\nendstream".to_vec(),
    ]
    .concat();
    let pdf = raw_pdf(&[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        &stream,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    assert_eq!(text_of(&pdf), ["Minimal"]);
}
