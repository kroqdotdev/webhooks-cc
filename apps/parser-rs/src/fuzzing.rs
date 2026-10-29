//! Entry points for the fuzz targets (`fuzz/`), not part of the binary's
//! interface.
//!
//! They reach the inner parsers without their containers: random mutations
//! of a whole XLS or PDF file rarely survive the compound file or the
//! cross-reference table, so the fuzzer would spend its time on those.
//! Each call swallows panics the way [`crate::parse`] does; the fuzz
//! targets install a hook that still aborts on a panic in this crate's own
//! code, so only library panics are tolerated.
#![doc(hidden)]

use std::io::{Cursor, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// The page cap the entry points use, small so the cap paths get hit.
const MAX_PAGES: u64 = 3;

fn quietly<T>(f: impl FnOnce() -> T) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

/// A BIFF workbook stream, as stored inside an .xls compound file.
pub fn xls_stream(data: &[u8]) {
    quietly(|| crate::xls::parse_stream(data, MAX_PAGES));
}

/// An ODS `content.xml` document.
pub fn ods_content(xml: &[u8]) {
    quietly(|| crate::ods::parse_content(xml, MAX_PAGES));
}

/// An XLSX worksheet part, wrapped in a workbook with shared strings and
/// date styles so cell references to them resolve.
pub fn xlsx_sheet(xml: &[u8]) {
    let Some(book) = workbook_around(xml) else {
        return;
    };
    quietly(|| crate::xlsx::parse(&book, MAX_PAGES));
}

/// A PDF content stream, interpreted against a small fixed document.
pub fn pdf_content(content: &[u8]) {
    quietly(|| crate::pdf::interpret_content(content));
}

/// A CMap, parsed and then used to decode its own bytes.
pub fn cmap(data: &[u8]) {
    quietly(|| crate::pdf::probe_cmap(data));
}

fn workbook_around(sheet: &[u8]) -> Option<Vec<u8>> {
    const PARTS: [(&str, &str); 6] = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="false"/><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
        ),
        (
            "xl/sharedStrings.xml",
            r#"<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>alpha</t></si><si><r><t>rich</t></r><r><t> text</t></r></si><si><t xml:space="preserve"> spaced </t></si></sst>"#,
        ),
        (
            "xl/styles.xml",
            r#"<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="[h]:mm"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="22"/></cellXfs></styleSheet>"#,
        ),
    ];
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in PARTS {
        w.start_file(name, stored).ok()?;
        w.write_all(data.as_bytes()).ok()?;
    }
    w.start_file("xl/worksheets/sheet1.xml", stored).ok()?;
    w.write_all(sheet).ok()?;
    Some(w.finish().ok()?.into_inner())
}
