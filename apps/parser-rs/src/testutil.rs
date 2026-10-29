//! Builders for test fixtures, so tests generate their files instead of
//! committing binaries: XLSX through rust_xlsxwriter or raw XML, ODS as raw
//! XML in a zip, and XLS as BIFF8 records in a compound file.

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;

pub(crate) fn zip_entries(entries: &[(&str, &[u8])], stored_first: bool) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (i, (name, data)) in entries.iter().enumerate() {
        let method = if stored_first && i == 0 {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        let opts = SimpleFileOptions::default()
            .compression_method(method)
            .large_file(data.len() > u32::MAX as usize / 2);
        w.start_file(*name, opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// An ODS file whose `content.xml` holds `body` inside `office:spreadsheet`,
/// with `styles` as automatic styles.
pub(crate) fn ods(styles: &str, body: &str) -> Vec<u8> {
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"><office:automatic-styles>{styles}</office:automatic-styles><office:body><office:spreadsheet>{body}</office:spreadsheet></office:body></office:document-content>"#
    );
    let manifest = r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>"#;
    zip_entries(
        &[
            (
                "mimetype",
                b"application/vnd.oasis.opendocument.spreadsheet",
            ),
            ("content.xml", content.as_bytes()),
            ("META-INF/manifest.xml", manifest.as_bytes()),
        ],
        true,
    )
}

/// An XLSX file built from raw sheet XML (one `<sheetData>` body per
/// sheet), for shapes rust_xlsxwriter will not write.
pub(crate) fn raw_xlsx(sheets: &[&[u8]]) -> Vec<u8> {
    let mut content_types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>"#,
    );
    let mut workbook = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>"#,
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for i in 1..=sheets.len() {
        content_types.push_str(&format!(r#"<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#));
        workbook.push_str(&format!(
            r#"<sheet name="Sheet{i}" sheetId="{i}" r:id="rId{i}"/>"#
        ));
        rels.push_str(&format!(r#"<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>"#));
    }
    content_types.push_str("</Types>");
    workbook.push_str("</sheets></workbook>");
    rels.push_str("</Relationships>");
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
    let sheet_xml: Vec<Vec<u8>> = sheets
        .iter()
        .map(|body| {
            let mut x = br#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>"#.to_vec();
            x.extend_from_slice(body);
            x.extend_from_slice(b"</sheetData></worksheet>");
            x
        })
        .collect();
    let names: Vec<String> = (1..=sheets.len())
        .map(|i| format!("xl/worksheets/sheet{i}.xml"))
        .collect();
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
    ];
    for (name, xml) in names.iter().zip(&sheet_xml) {
        entries.push((name, xml));
    }
    zip_entries(&entries, false)
}

/// A minimal BIFF8 workbook writer.
#[derive(Default)]
pub(crate) struct Xls {
    pub sst: Vec<String>,
    pub formats: Vec<(u16, String)>,
    /// Number format index of each XF record, in order.
    pub xfs: Vec<u16>,
    pub date1904: bool,
    /// (name, hidden state, cell records).
    pub sheets: Vec<(String, u8, Vec<u8>)>,
    /// Start a CONTINUE record before this string, as Excel does when the
    /// table outgrows one record.
    pub sst_split: Option<usize>,
}

pub(crate) fn record(typ: u16, data: &[u8]) -> Vec<u8> {
    let mut r = typ.to_le_bytes().to_vec();
    r.extend_from_slice(&(data.len() as u16).to_le_bytes());
    r.extend_from_slice(data);
    r
}

fn cell_head(row: u16, col: u16, xf: u16) -> Vec<u8> {
    let mut d = row.to_le_bytes().to_vec();
    d.extend_from_slice(&col.to_le_bytes());
    d.extend_from_slice(&xf.to_le_bytes());
    d
}

/// A BIFF8 unicode string with a 2-byte length, stored as UTF-16 when it
/// is not Latin-1.
pub(crate) fn unicode(s: &str) -> Vec<u8> {
    let units: Vec<u16> = s.encode_utf16().collect();
    let mut d = (units.len() as u16).to_le_bytes().to_vec();
    if s.chars().all(|c| (c as u32) < 256) {
        d.push(0);
        d.extend(s.chars().map(|c| c as u8));
    } else {
        d.push(1);
        for u in units {
            d.extend_from_slice(&u.to_le_bytes());
        }
    }
    d
}

impl Xls {
    pub(crate) fn number(row: u16, col: u16, xf: u16, v: f64) -> Vec<u8> {
        let mut d = cell_head(row, col, xf);
        d.extend_from_slice(&v.to_le_bytes());
        record(0x0203, &d)
    }

    pub(crate) fn rk_int(row: u16, col: u16, xf: u16, v: i32) -> Vec<u8> {
        let mut d = cell_head(row, col, xf);
        d.extend_from_slice(&(((v << 2) | 0x02) as u32).to_le_bytes());
        record(0x027E, &d)
    }

    pub(crate) fn mulrk(row: u16, first: u16, values: &[i32]) -> Vec<u8> {
        let mut d = row.to_le_bytes().to_vec();
        d.extend_from_slice(&first.to_le_bytes());
        for v in values {
            d.extend_from_slice(&0u16.to_le_bytes());
            d.extend_from_slice(&(((v << 2) | 0x02) as u32).to_le_bytes());
        }
        d.extend_from_slice(&(first + values.len() as u16 - 1).to_le_bytes());
        record(0x00BD, &d)
    }

    pub(crate) fn sst_cell(row: u16, col: u16, index: u32) -> Vec<u8> {
        let mut d = cell_head(row, col, 0);
        d.extend_from_slice(&index.to_le_bytes());
        record(0x00FD, &d)
    }

    pub(crate) fn label(row: u16, col: u16, text: &str) -> Vec<u8> {
        let mut d = cell_head(row, col, 0);
        d.extend(unicode(text));
        record(0x0204, &d)
    }

    pub(crate) fn boolerr(row: u16, col: u16, value: u8, is_error: bool) -> Vec<u8> {
        let mut d = cell_head(row, col, 0);
        d.push(value);
        d.push(u8::from(is_error));
        record(0x0205, &d)
    }

    /// A formula with a cached string result, followed by its STRING record.
    pub(crate) fn formula_text(row: u16, col: u16, text: &str) -> Vec<u8> {
        let mut d = cell_head(row, col, 0);
        d.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0xFF, 0xFF]);
        d.extend_from_slice(&[0; 6]);
        d.extend_from_slice(&[0, 0]);
        let mut r = record(0x0006, &d);
        r.extend(record(0x0207, &unicode(text)));
        r
    }

    pub(crate) fn formula_number(row: u16, col: u16, v: f64) -> Vec<u8> {
        let mut d = cell_head(row, col, 0);
        d.extend_from_slice(&v.to_le_bytes());
        d.extend_from_slice(&[0; 6]);
        d.extend_from_slice(&[0, 0]);
        record(0x0006, &d)
    }

    /// The Workbook stream.
    pub(crate) fn stream(&self) -> Vec<u8> {
        let mut globals = record(0x0809, &[0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0]);
        globals.extend(record(0x0042, &1200u16.to_le_bytes()));
        globals.extend(record(0x0022, &u16::from(self.date1904).to_le_bytes()));
        for (ifmt, text) in &self.formats {
            let mut d = ifmt.to_le_bytes().to_vec();
            d.extend(unicode(text));
            globals.extend(record(0x041E, &d));
        }
        for ifmt in &self.xfs {
            let mut d = vec![0u8; 20];
            d[2..4].copy_from_slice(&ifmt.to_le_bytes());
            globals.extend(record(0x00E0, &d));
        }
        let mut sst = Vec::new();
        sst.extend_from_slice(&(self.sst.len() as u32).to_le_bytes());
        sst.extend_from_slice(&(self.sst.len() as u32).to_le_bytes());
        let mut split_at = None;
        for (i, s) in self.sst.iter().enumerate() {
            if self.sst_split == Some(i) {
                split_at = Some(sst.len());
            }
            sst.extend(unicode(s));
        }
        // BOUNDSHEET records come before the SST; their positions are
        // patched once the globals' length is known.
        let mut boundsheet_at = Vec::new();
        for (name, hidden, _) in &self.sheets {
            boundsheet_at.push(globals.len() + 4);
            let mut d = vec![0, 0, 0, 0, *hidden, 0];
            d.push(name.len() as u8);
            d.push(0);
            d.extend_from_slice(name.as_bytes());
            globals.extend(record(0x0085, &d));
        }
        match split_at {
            Some(at) => {
                globals.extend(record(0x00FC, &sst[..at]));
                globals.extend(record(0x003C, &sst[at..]));
            }
            _ => globals.extend(record(0x00FC, &sst)),
        }
        globals.extend(record(0x000A, &[]));
        let mut stream = globals;
        for (i, (_, _, cells)) in self.sheets.iter().enumerate() {
            let pos = stream.len() as u32;
            stream[boundsheet_at[i]..boundsheet_at[i] + 4].copy_from_slice(&pos.to_le_bytes());
            stream.extend(record(0x0809, &[0x00, 0x06, 0x10, 0x00, 0, 0, 0, 0]));
            stream.extend_from_slice(cells);
            stream.extend(record(0x000A, &[]));
        }
        stream
    }

    /// The workbook as an .xls file (a compound file holding the stream).
    pub(crate) fn build(&self) -> Vec<u8> {
        compound_file(&[("/Workbook", &self.stream())])
    }
}

pub(crate) fn compound_file(streams: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cfb = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    for (name, data) in streams {
        let mut s = cfb.create_stream(name).unwrap();
        s.write_all(data).unwrap();
    }
    cfb.flush().unwrap();
    cfb.into_inner().into_inner()
}
