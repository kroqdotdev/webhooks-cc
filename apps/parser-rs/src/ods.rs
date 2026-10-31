//! ODS (OpenDocument spreadsheets), read straight from `content.xml`.
//!
//! calamine's ODS reader builds every sheet as a dense rectangle and clones
//! a cell once per `number-columns-repeated`, so a few hundred bytes of XML
//! can ask for gigabytes. This reader streams rows into the sheet builder
//! instead: repeated empty rows are a counter, repeated cells stop at the
//! column cap, and repeated rows stop at the page and cell caps.

use std::io::{BufReader, Cursor, Read};

use quick_xml::events::{BytesStart, Event};
use quick_xml::name::QName;
use quick_xml::{Reader, XmlVersion};

use crate::cell::{MAX_CELL_BYTES, MAX_COLUMNS, clip_owned, number};
use crate::output::{ErrorCode, Failure, Sheet};
use crate::sheet::{Flow, SheetsBuilder};
use crate::zipguard;

const MALFORMED: Failure = Failure::malformed("the file is not a readable ODS spreadsheet");

pub(crate) fn parse(input: &[u8], max_pages: u64) -> Result<(Vec<Sheet>, u64, bool), Failure> {
    zipguard::check(input)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(input)).map_err(|_| MALFORMED)?;
    if is_encrypted(&mut archive) {
        return Err(Failure::new(
            ErrorCode::Encrypted,
            "the spreadsheet is password protected",
        ));
    }
    let content = archive.by_name("content.xml").map_err(|_| MALFORMED)?;
    parse_content(BufReader::new(content), max_pages)
}

/// Parses a `content.xml` document.
pub(crate) fn parse_content<R: std::io::BufRead>(
    xml: R,
    max_pages: u64,
) -> Result<(Vec<Sheet>, u64, bool), Failure> {
    let mut reader = Reader::from_reader(xml);
    let config = reader.config_mut();
    config.trim_text(false);
    config.check_end_names = false;
    config.expand_empty_elements = false;

    let mut sheets = SheetsBuilder::new(max_pages);
    read_content(&mut reader, &mut sheets).map_err(|_| MALFORMED)?;
    sheets.finish().ok_or(Failure::new(
        ErrorCode::Empty,
        "the spreadsheet has no cells with values",
    ))
}

/// An encrypted ODS keeps a readable manifest that lists the encryption
/// parameters, while `content.xml` itself is ciphertext.
fn is_encrypted<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> bool {
    let Ok(manifest) = archive.by_name("META-INF/manifest.xml") else {
        return false;
    };
    let mut buf = Vec::new();
    if manifest.take(1024 * 1024).read_to_end(&mut buf).is_err() {
        return false;
    }
    buf.windows(b"encryption-data".len())
        .any(|w| w == b"encryption-data")
}

type XmlError = quick_xml::Error;

fn read_content<R: std::io::BufRead>(
    reader: &mut Reader<R>,
    sheets: &mut SheetsBuilder,
) -> Result<(), XmlError> {
    let mut buf = Vec::with_capacity(4096);
    let mut skip_buf = Vec::new();
    let mut hidden_styles: Vec<Vec<u8>> = Vec::new();
    let mut table_style: Option<Vec<u8>> = None;
    let mut in_table = false;
    let mut row: Option<Row> = None;

    loop {
        buf.clear();
        let event = reader.read_event_into(&mut buf)?;
        match event {
            // A document that ends inside a table was cut short.
            Event::Eof if in_table => {
                return Err(XmlError::Syntax(
                    quick_xml::errors::SyntaxError::UnclosedTag,
                ));
            }
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.name().as_ref() {
                    "style:style" => {
                        table_style = None;
                        if !empty && attr(e, "style:family").as_deref() == Some("table") {
                            table_style = attr(e, "style:name").map(String::into_bytes);
                        }
                    }
                    "style:table-properties" => {
                        if let Some(style) = &table_style
                            && attr(e, "table:display").as_deref() == Some("false")
                        {
                            hidden_styles.push(style.clone());
                        }
                    }
                    "table:table" => {
                        let style = attr(e, "table:style-name").map(String::into_bytes);
                        let hidden = style.is_some_and(|s| hidden_styles.contains(&s));
                        if in_table || hidden {
                            // Tables nested in a cell and hidden sheets are
                            // skipped whole.
                            if !empty {
                                let name = e.name().as_ref().to_string();
                                reader.read_to_end_into(QName(&name), &mut skip_buf)?;
                            }
                            continue;
                        }
                        if sheets.start_sheet(attr(e, "table:name")) == Flow::Stop {
                            return Ok(());
                        }
                        if empty {
                            sheets.finish_sheet();
                        } else {
                            in_table = true;
                        }
                    }
                    "table:table-row" if in_table => {
                        let repeat = repeat_attr(e, "table:number-rows-repeated");
                        if empty {
                            sheets.push_empty_rows(repeat);
                        } else {
                            row = Some(Row {
                                cells: Vec::new(),
                                repeat,
                            });
                        }
                    }
                    "table:table-cell" | "table:covered-table-cell" => {
                        let Some(current) = row.as_mut() else {
                            if !empty {
                                let name = e.name().as_ref().to_string();
                                reader.read_to_end_into(QName(&name), &mut skip_buf)?;
                            }
                            continue;
                        };
                        let repeat = repeat_attr(e, "table:number-columns-repeated");
                        let attrs = CellAttrs::read(e);
                        let text = if empty {
                            String::new()
                        } else {
                            read_cell_text(reader, &mut skip_buf)?
                        };
                        let value = attrs.value(text);
                        let room = MAX_COLUMNS.saturating_sub(current.cells.len());
                        let n = usize::try_from(repeat).unwrap_or(usize::MAX).min(room);
                        for _ in 0..n {
                            current.cells.push(value.clone());
                        }
                    }
                    _ => {}
                }
            }
            Event::End(ref e) => match e.name().as_ref() {
                "style:style" => table_style = None,
                "table:table-row" => {
                    if let Some(done) = row.take()
                        && emit_row(sheets, done) == Flow::Stop
                    {
                        return Ok(());
                    }
                }
                "table:table" if in_table => {
                    in_table = false;
                    row = None;
                    sheets.finish_sheet();
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}

struct Row {
    cells: Vec<String>,
    repeat: u64,
}

fn emit_row(sheets: &mut SheetsBuilder, row: Row) -> Flow {
    if row.cells.iter().all(String::is_empty) {
        return sheets.push_empty_rows(row.repeat);
    }
    // A repeated row with content is pushed once per repeat; the page and
    // cell caps end the loop long before a hostile repeat count would.
    for _ in 0..row.repeat {
        if sheets.push_row(row.cells.clone()) == Flow::Stop {
            return Flow::Stop;
        }
    }
    Flow::Continue
}

/// A repeat attribute, at least 1. Values that do not parse count as 1.
fn repeat_attr(e: &BytesStart<'_>, name: &str) -> u64 {
    attr(e, name)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(1)
        .max(1)
}

fn attr(e: &BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes()
        .with_checks(false)
        .flatten()
        .find(|a| a.key.as_ref() == name)
        .and_then(|a| a.normalized_value(XmlVersion::Implicit1_0).ok())
        .map(|v| v.into_owned())
}

#[derive(Default)]
struct CellAttrs {
    value_type: Option<String>,
    value: Option<String>,
    date: Option<String>,
    time: Option<String>,
    boolean: Option<String>,
    string: Option<String>,
}

impl CellAttrs {
    fn read(e: &BytesStart<'_>) -> Self {
        let mut attrs = Self::default();
        for a in e.attributes().with_checks(false).flatten() {
            let slot = match a.key.as_ref() {
                "office:value-type" => &mut attrs.value_type,
                "office:value" => &mut attrs.value,
                "office:date-value" => &mut attrs.date,
                "office:time-value" => &mut attrs.time,
                "office:boolean-value" => &mut attrs.boolean,
                "office:string-value" => &mut attrs.string,
                _ => continue,
            };
            if let Ok(v) = a.normalized_value(XmlVersion::Implicit1_0) {
                *slot = Some(v.into_owned());
            }
        }
        attrs
    }

    /// The cell's value: the typed attribute for numbers, dates, times and
    /// booleans (what the sender's spreadsheet holds, not how it is
    /// formatted), and the displayed text for everything else.
    fn value(self, text: String) -> String {
        let typed = match self.value_type.as_deref() {
            Some("float" | "percentage" | "currency") => self
                .value
                .as_deref()
                .and_then(|v| v.trim().parse::<f64>().ok())
                .map(number),
            Some("date") => self.date,
            Some("time") => self.time,
            Some("boolean") => self.boolean.map(|b| {
                let b = b.trim();
                (b.eq_ignore_ascii_case("true") || b == "1").to_string()
            }),
            Some("string") => self.string,
            _ => None,
        };
        clip_owned(typed.unwrap_or(text))
    }
}

/// Reads the text of a cell up to its end tag. Paragraphs are joined with
/// newlines; comments (`office:annotation`) are not part of the value.
fn read_cell_text<R: std::io::BufRead>(
    reader: &mut Reader<R>,
    buf: &mut Vec<u8>,
) -> Result<String, XmlError> {
    let mut text = String::new();
    let mut depth = 1usize;
    let mut paragraphs = 0usize;
    let mut skip_buf = Vec::new();
    loop {
        buf.clear();
        let event = reader.read_event_into(buf)?;
        match event {
            Event::Eof => {
                return Err(XmlError::Syntax(
                    quick_xml::errors::SyntaxError::UnclosedTag,
                ));
            }
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.name().as_ref() {
                    "office:annotation" => {
                        if !empty {
                            let name = e.name().as_ref().to_string();
                            reader.read_to_end_into(QName(&name), &mut skip_buf)?;
                        }
                        continue;
                    }
                    "text:p" | "text:h" => {
                        if paragraphs > 0 {
                            push_capped(&mut text, "\n");
                        }
                        paragraphs += 1;
                    }
                    "text:s" => {
                        let n = repeat_attr_named(e, "text:c");
                        let room = MAX_CELL_BYTES.saturating_sub(text.len());
                        text.extend(std::iter::repeat_n(' ', n.min(room)));
                    }
                    "text:tab" => push_capped(&mut text, "\t"),
                    "text:line-break" => push_capped(&mut text, "\n"),
                    _ => {}
                }
                if !empty {
                    depth += 1;
                }
            }
            Event::Text(t) => push_capped(&mut text, &t.xml10_content()),
            Event::CData(t) => push_capped(&mut text, &t.xml10_content()),
            Event::GeneralRef(r) => {
                if let Some(s) = quick_xml::escape::resolve_xml_entity(&r) {
                    push_capped(&mut text, s);
                } else if let Ok(Some(c)) = r.resolve_char_ref() {
                    push_capped(&mut text, c.encode_utf8(&mut [0; 4]));
                }
            }
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    return Ok(text);
                }
            }
            _ => {}
        }
    }
}

fn repeat_attr_named(e: &BytesStart<'_>, name: &str) -> usize {
    attr(e, name)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(1)
}

/// Appends while the cell is under the size cap; the rest of a huge cell is
/// read and dropped.
fn push_capped(text: &mut String, s: &str) {
    let room = MAX_CELL_BYTES.saturating_sub(text.len());
    if room == 0 {
        return;
    }
    let cut = crate::cell::floor_char_boundary(s, room);
    text.push_str(&s[..cut]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{ods, zip_entries};

    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    fn table(name: &str, rows: &str) -> String {
        format!(r#"<table:table table:name="{name}">{rows}</table:table>"#)
    }

    #[test]
    fn values_of_every_type() {
        let rows = r#"<table:table-row>
            <table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell>
            <table:table-cell office:value-type="float" office:value="1"><text:p>1.00</text:p></table:table-cell>
            <table:table-cell office:value-type="percentage" office:value="0.25"><text:p>25%</text:p></table:table-cell>
            <table:table-cell office:value-type="currency" office:value="-3.5"><text:p>-$3.50</text:p></table:table-cell>
          </table:table-row>
          <table:table-row>
            <table:table-cell office:value-type="date" office:date-value="2026-10-29"><text:p>29/10/26</text:p></table:table-cell>
            <table:table-cell office:value-type="date" office:date-value="2026-10-29T13:45:00"><text:p>x</text:p></table:table-cell>
            <table:table-cell office:value-type="time" office:time-value="PT13H45M00S"><text:p>13:45</text:p></table:table-cell>
            <table:table-cell office:value-type="boolean" office:boolean-value="true"><text:p>TRUE</text:p></table:table-cell>
          </table:table-row>
          <table:table-row>
            <table:table-cell office:value-type="string"><text:p>a<text:s text:c="3"/>b<text:tab/>c</text:p><text:p>second <text:span>line</text:span> &amp; more</text:p><office:annotation><text:p>a comment</text:p></office:annotation></table:table-cell>
            <table:table-cell office:value-type="string" calcext:value-type="error"><text:p>#DIV/0!</text:p></table:table-cell>
          </table:table-row>"#;
        let file = ods("", &table("Data", rows));
        let (sheets, pages, truncated) = parse(&file, 100).unwrap();
        assert_eq!((pages, truncated), (1, false));
        assert_eq!(sheets[0].name.as_deref(), Some("Data"));
        assert_eq!(
            sheets[0].rows,
            strings(&[
                &["Name", "1", "0.25", "-3.5"],
                &["2026-10-29", "2026-10-29T13:45:00", "PT13H45M00S", "true"],
                &["a   b\tc\nsecond line & more", "#DIV/0!"],
            ])
        );
    }

    #[test]
    fn repeated_cells_and_rows_expand_within_the_caps() {
        let rows = r#"<table:table-row table:number-rows-repeated="2"><table:table-cell/></table:table-row>
          <table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="7"/><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
          <table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="string" table:number-columns-repeated="2"><text:p>r</text:p></table:table-cell></table:table-row>
          <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>"#;
        let (sheets, pages, truncated) = parse(&ods("", &table("S", rows)), 100).unwrap();
        assert!(!truncated);
        assert_eq!(pages, 1);
        assert_eq!(
            sheets[0].rows,
            strings(&[
                &[],
                &[],
                &["", "", "7"],
                &["r", "r"],
                &["r", "r"],
                &["r", "r"]
            ])
        );
    }

    #[test]
    fn a_hostile_repeat_count_stops_at_the_caps() {
        let rows = r#"<table:table-row table:number-rows-repeated="4000000000"><table:table-cell office:value-type="string" table:number-columns-repeated="4000000000"><text:p>x</text:p></table:table-cell></table:table-row>"#;
        let started = std::time::Instant::now();
        let (sheets, pages, truncated) = parse(&ods("", &table("S", rows)), 100).unwrap();
        assert!(truncated);
        // The cell cap (wide rows) or the page cap, whichever comes first.
        assert!(pages <= 100);
        assert_eq!(sheets[0].rows[0].len(), crate::cell::MAX_COLUMNS);
        assert!(started.elapsed().as_secs() < 30);
    }

    #[test]
    fn hidden_tables_are_left_out() {
        let styles = r#"<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style>"#;
        let one = r#"<table:table-row><table:table-cell office:value-type="string"><text:p>shown</text:p></table:table-cell></table:table-row>"#;
        let body = format!(
            r#"{}<table:table table:name="Hidden" table:style-name="ta2">{one}</table:table>"#,
            table("Shown", one)
        );
        let (sheets, _, _) = parse(&ods(styles, &body), 100).unwrap();
        let names: Vec<_> = sheets.iter().map(|s| s.name.clone().unwrap()).collect();
        assert_eq!(names, ["Shown"]);
    }

    #[test]
    fn sheets_are_counted_and_capped_like_the_other_formats() {
        let rows = |n: usize| {
            r#"<table:table-row><table:table-cell office:value-type="float" office:value="1"/></table:table-row>"#.repeat(n)
        };
        let body = table("A", &rows(1001)) + &table("B", &rows(5000)) + &table("C", &rows(1));
        let (sheets, pages, truncated) = parse(&ods("", &body), 4).unwrap();
        assert!(truncated);
        assert_eq!(pages, 4);
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0].row_count, 1001);
        assert_eq!(sheets[1].row_count, 2000);
    }

    #[test]
    fn encrypted_spreadsheets_are_reported() {
        let manifest = br#"<manifest:manifest><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>"#;
        let file = zip_entries(
            &[
                (
                    "mimetype",
                    b"application/vnd.oasis.opendocument.spreadsheet",
                ),
                ("content.xml", b"\x8f\x01ciphertext"),
                ("META-INF/manifest.xml", manifest),
            ],
            true,
        );
        assert_eq!(parse(&file, 100).unwrap_err().code, ErrorCode::Encrypted);
    }

    #[test]
    fn broken_xml_and_missing_content_are_malformed() {
        let file = ods(
            "",
            "<table:table table:name=\"x\"><table:table-row><table:table-cell",
        );
        assert_eq!(parse(&file, 100).unwrap_err().code, ErrorCode::Malformed);
        let file = zip_entries(
            &[(
                "mimetype",
                b"application/vnd.oasis.opendocument.spreadsheet",
            )],
            true,
        );
        assert_eq!(parse(&file, 100).unwrap_err().code, ErrorCode::Malformed);
    }

    #[test]
    fn an_empty_spreadsheet_is_empty() {
        assert_eq!(
            parse(&ods("", &table("S", "")), 100).unwrap_err().code,
            ErrorCode::Empty
        );
    }
}
