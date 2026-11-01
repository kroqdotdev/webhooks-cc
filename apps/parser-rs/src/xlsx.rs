//! XLSX through calamine's streaming cell reader.
//!
//! The cell reader walks the sheet XML in order, so a sheet with millions of
//! rows stops at the page cap instead of being loaded whole (calamine's
//! `worksheet_range` would allocate the full rectangle first).

use std::io::Cursor;

use calamine::{CellErrorType, DataRef, Reader, SheetType, SheetVisible, Xlsx, XlsxError};

use crate::cell::{MAX_COLUMNS, clip, excel_datetime, excel_duration, number};
use crate::output::{ErrorCode, Failure, Sheet};
use crate::sheet::{Flow, SheetsBuilder};
use crate::zipguard;

const MALFORMED: Failure = Failure::malformed("the file is not a readable XLSX workbook");

/// Cells read across the whole workbook, empty ones included. Sheets can all
/// point at one large part, which the zip guard counts once but the reader
/// would inflate and walk once per sheet; this bounds that work. A hundred
/// pages of thirty columns is three million cells.
pub(crate) const MAX_CELLS_VISITED: u64 = 5_000_000;

pub(crate) fn parse(input: &[u8], max_pages: u64) -> Result<(Vec<Sheet>, u64, bool), Failure> {
    zipguard::check(input)?;
    let mut book: Xlsx<_> = match Xlsx::new(Cursor::new(input)) {
        Ok(book) => book,
        Err(XlsxError::Password) => {
            return Err(Failure::new(
                ErrorCode::Encrypted,
                "the workbook is password protected",
            ));
        }
        Err(_) => return Err(MALFORMED),
    };
    let is_1904 = book.has_1904_epoch();
    // Hidden sheets are left out: the sender never sees them in Excel, and
    // they often hold large lookup tables that would only cost pages.
    // Each part is read once: sheets that name a part another sheet already
    // named are left out (a crafted workbook lists one large part a thousand
    // times, which the zip guard counts once but the reader would walk once
    // per sheet).
    let targets = sheet_targets(input);
    let mut read_parts = std::collections::HashSet::new();
    let names: Vec<String> = book
        .sheets_metadata()
        .iter()
        .filter(|s| s.typ == SheetType::WorkSheet && s.visible == SheetVisible::Visible)
        .filter(|s| match targets.as_ref().and_then(|t| t.get(&s.name)) {
            Some(target) => read_parts.insert(target.clone()),
            None => true,
        })
        .map(|s| s.name.clone())
        .collect();

    let mut sheets = SheetsBuilder::new(max_pages);
    let mut visited: u64 = 0;
    for name in names {
        let mut reader = match book.worksheet_cells_reader(&name) {
            Ok(reader) => reader,
            // A part that turns out not to be a worksheet (a chart or a
            // dialog sheet listed as one) has no cells to give.
            Err(XlsxError::NotAWorksheet(_)) => continue,
            Err(_) => return Err(MALFORMED),
        };
        if sheets.start_sheet(Some(name)) == Flow::Stop {
            break;
        }
        let mut row: Vec<String> = Vec::new();
        let mut row_index: Option<u32> = None;
        loop {
            let cell = match reader.next_cell() {
                Ok(Some(cell)) => cell,
                Ok(None) => break,
                Err(_) => return Err(MALFORMED),
            };
            visited += 1;
            if visited > MAX_CELLS_VISITED {
                // Keep what was read, marked truncated, as for any budget.
                if row_index.is_some() {
                    sheets.push_row(std::mem::take(&mut row));
                }
                sheets.give_up();
                break;
            }
            let (r, c) = cell.get_position();
            match row_index {
                None => {
                    // Rows are anchored at row 1, so leading empty rows stay
                    // and row numbers match what the sender sees.
                    sheets.push_empty_rows(u64::from(r));
                    row_index = Some(r);
                }
                Some(current) if r == current => {}
                Some(current) if r > current => {
                    if sheets.push_row(std::mem::take(&mut row)) == Flow::Stop {
                        break;
                    }
                    sheets.push_empty_rows(u64::from(r - current - 1));
                    row_index = Some(r);
                }
                // Rows out of order break the format's rules; a streaming
                // reader cannot go back, so the stray cell is dropped.
                Some(_) => continue,
            }
            let c = c as usize;
            if c >= MAX_COLUMNS {
                continue;
            }
            let value = render(cell.get_value(), is_1904);
            if value.is_empty() {
                continue;
            }
            if row.len() <= c {
                row.resize(c + 1, String::new());
            }
            row[c] = value;
        }
        if sheets.is_stopped() {
            break;
        }
        if row_index.is_some() && sheets.push_row(row) == Flow::Stop {
            break;
        }
    }
    sheets.finish().ok_or(Failure::new(
        ErrorCode::Empty,
        "the workbook has no cells with values",
    ))
}

/// Which part each sheet names, by sheet name, from the workbook and its
/// relationships; None when they cannot be read (every sheet is read then).
fn sheet_targets(input: &[u8]) -> Option<std::collections::HashMap<String, String>> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    fn read(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<Vec<u8>> {
        let mut file = archive.by_name(name).ok()?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(&mut file, 4 << 20), &mut buf).ok()?;
        Some(buf)
    }
    // Attributes by local name, so a prefix (r:id) does not matter.
    fn attr(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
        e.attributes()
            .with_checks(false)
            .flatten()
            .find(|a| a.key.local_name().as_ref() == key)
            .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok())
            .map(|v| v.into_owned())
    }

    let mut archive = zip::ZipArchive::new(Cursor::new(input)).ok()?;
    let rels = read(&mut archive, "xl/_rels/workbook.xml.rels")?;
    let workbook = read(&mut archive, "xl/workbook.xml")?;

    let mut by_id = std::collections::HashMap::new();
    let mut reader = Reader::from_reader(rels.as_slice());
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).ok()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "Relationship" => {
                if let (Some(id), Some(target)) = (attr(&e, "Id"), attr(&e, "Target")) {
                    by_id.insert(id, target.trim_start_matches('/').to_string());
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let mut targets = std::collections::HashMap::new();
    let mut reader = Reader::from_reader(workbook.as_slice());
    loop {
        match reader.read_event_into(&mut buf).ok()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == "sheet" => {
                let target = attr(&e, "id").and_then(|id| by_id.get(&id));
                if let (Some(name), Some(target)) = (attr(&e, "name"), target) {
                    targets.insert(name, target.clone());
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Some(targets)
}

fn render(value: &DataRef<'_>, is_1904: bool) -> String {
    match value {
        DataRef::Int(i) => i.to_string(),
        DataRef::Float(f) => number(*f),
        DataRef::String(s) => clip(s),
        DataRef::SharedString(s) => clip(s),
        DataRef::Bool(b) => b.to_string(),
        DataRef::DateTime(dt) if dt.is_duration() => excel_duration(dt.as_f64()),
        DataRef::DateTime(dt) => excel_datetime(dt.as_f64(), is_1904),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => clip(s),
        DataRef::Error(CellErrorType::GettingData) => "#GETTING_DATA".to_string(),
        DataRef::Error(e) => e.to_string(),
        DataRef::Empty => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{compound_file, raw_xlsx};
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    fn numbered_rows(n: usize) -> String {
        (1..=n)
            .map(|r| format!(r#"<row r="{r}"><c r="A{r}"><v>{r}</v></c></row>"#))
            .collect()
    }

    #[test]
    fn values_of_every_type() {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Report").unwrap();
        let date = Format::new().set_num_format("yyyy-mm-dd");
        let datetime = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        let time = Format::new().set_num_format("hh:mm");
        let elapsed = Format::new().set_num_format("[h]:mm:ss");
        ws.write_string(0, 0, "Name").unwrap();
        ws.write_string(0, 1, "Amount").unwrap();
        ws.write_string(0, 2, "When").unwrap();
        ws.write_string(1, 0, "Acme").unwrap();
        ws.write_number(1, 1, 1.0).unwrap();
        let day = ExcelDateTime::from_ymd(2026, 10, 29).unwrap();
        ws.write_datetime_with_format(1, 2, &day, &date).unwrap();
        ws.write_boolean(2, 0, true).unwrap();
        ws.write_number(2, 1, 0.1 + 0.2).unwrap();
        let moment = ExcelDateTime::from_ymd(2026, 10, 29)
            .unwrap()
            .and_hms(13, 45, 0)
            .unwrap();
        ws.write_datetime_with_format(2, 2, &moment, &datetime)
            .unwrap();
        ws.write_number(3, 1, -2.5).unwrap();
        let clock = ExcelDateTime::from_hms(9, 30, 0).unwrap();
        ws.write_datetime_with_format(3, 2, &clock, &time).unwrap();
        ws.write_number_with_format(3, 3, 1.5, &elapsed).unwrap();
        let book = wb.save_to_buffer().unwrap();
        let (sheets, pages, truncated) = parse(&book, 100).unwrap();
        assert_eq!((pages, truncated), (1, false));
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name.as_deref(), Some("Report"));
        assert_eq!(
            sheets[0].rows,
            strings(&[
                &["Name", "Amount", "When"],
                &["Acme", "1", "2026-10-29"],
                &["true", "0.3", "2026-10-29T13:45:00"],
                &["", "-2.5", "09:30:00", "PT36H00M00S"],
            ])
        );
    }

    #[test]
    fn hidden_sheets_are_left_out_and_empty_ones_kept() {
        let mut wb = Workbook::new();
        wb.add_worksheet()
            .set_name("Visible")
            .unwrap()
            .write_string(0, 0, "a")
            .unwrap();
        let hidden = wb.add_worksheet();
        hidden.set_name("Lookup").unwrap();
        hidden.write_string(0, 0, "secret").unwrap();
        hidden.set_hidden(true);
        wb.add_worksheet().set_name("Empty").unwrap();
        let (sheets, pages, _) = parse(&wb.save_to_buffer().unwrap(), 100).unwrap();
        let names: Vec<_> = sheets.iter().map(|s| s.name.clone().unwrap()).collect();
        assert_eq!(names, ["Visible", "Empty"]);
        assert_eq!(pages, 1);
        assert_eq!(sheets[1].row_count, 0);
    }

    #[test]
    fn rows_and_columns_are_anchored_at_a1() {
        let book = raw_xlsx(&[
            br#"<row r="3"><c r="C3" t="inlineStr"><is><t>x</t></is></c></row><row r="5"><c r="A5"><v>1</v></c><c r="E5"><v>2</v></c></row>"#,
        ]);
        let (sheets, _, _) = parse(&book, 100).unwrap();
        assert_eq!(
            sheets[0].rows,
            strings(&[&[], &[], &["", "", "x"], &[], &["1", "", "", "", "2"]])
        );
    }

    #[test]
    fn page_counts_follow_rows() {
        for (n, pages) in [(1usize, 1u64), (999, 1), (1000, 1), (1001, 2), (2000, 2)] {
            let body = numbered_rows(n);
            let (sheets, used, truncated) = parse(&raw_xlsx(&[body.as_bytes()]), 100).unwrap();
            assert_eq!(used, pages, "{n} rows");
            assert!(!truncated);
            assert_eq!(sheets[0].row_count, n as u64);
        }
    }

    #[test]
    fn a_sheet_crossing_the_cap_is_cut_and_later_sheets_dropped() {
        let (a, b, c) = (numbered_rows(1500), numbered_rows(2500), numbered_rows(10));
        let book = raw_xlsx(&[a.as_bytes(), b.as_bytes(), c.as_bytes()]);
        let (sheets, pages, truncated) = parse(&book, 3).unwrap();
        assert!(truncated);
        assert_eq!(pages, 3);
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0].row_count, 1500);
        assert_eq!(sheets[1].row_count, 1000);
        assert!(sheets[1].truncated);
    }

    #[test]
    fn millions_of_rows_stop_at_the_cap_quickly() {
        let body = numbered_rows(2_000_000);
        let book = raw_xlsx(&[body.as_bytes()]);
        assert!(book.len() < crate::DEFAULT_MAX_INPUT_BYTES);
        let started = std::time::Instant::now();
        let (sheets, pages, truncated) = parse(&book, 100).unwrap();
        assert!(truncated);
        assert_eq!(pages, 100);
        assert_eq!(sheets[0].row_count, 100_000);
        assert_eq!(sheets[0].rows[99_999], vec!["100000".to_string()]);
        // Generous for debug builds; release takes a fraction of this.
        assert!(started.elapsed().as_secs() < 30, "{:?}", started.elapsed());
    }

    #[test]
    fn one_huge_shared_string_everywhere_is_capped_by_output_size() {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        // Excel's own limit on a string is 32,767 characters.
        let big = "z".repeat(32_000);
        for r in 0..3000 {
            ws.write_string(r, 0, big.as_str()).unwrap();
        }
        let (sheets, _, truncated) = parse(&wb.save_to_buffer().unwrap(), 100).unwrap();
        assert!(truncated);
        let kept: usize = sheets[0].rows.iter().flatten().map(String::len).sum();
        assert!(kept <= crate::sheet::MAX_OUTPUT_BYTES);
    }

    #[test]
    fn zip_bombs_are_refused() {
        // Megabytes of whitespace between rows deflate to almost nothing.
        let mut body = br#"<row r="1"><c r="A1"><v>1</v></c></row>"#.to_vec();
        body.extend(std::iter::repeat_n(b' ', 8 * 1024 * 1024));
        let book = raw_xlsx(&[&body]);
        assert_eq!(parse(&book, 100).unwrap_err().code, ErrorCode::ZipBomb);
    }

    #[test]
    fn encrypted_workbooks_are_reported() {
        let file = compound_file(&[("/EncryptionInfo", b"x"), ("/EncryptedPackage", b"y")]);
        let out = crate::parse(crate::Format::Xlsx, &file, &crate::Limits::default());
        assert_eq!(out.error_code(), Some(ErrorCode::Encrypted));
    }

    #[test]
    fn broken_sheet_xml_is_malformed() {
        let book = raw_xlsx(&[br#"<row r="1"><c r="A1"><v>1</v></c><row"#]);
        assert_eq!(parse(&book, 100).unwrap_err().code, ErrorCode::Malformed);
    }

    #[test]
    fn a_workbook_without_values_is_empty() {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        assert_eq!(
            parse(&wb.save_to_buffer().unwrap(), 100).unwrap_err().code,
            ErrorCode::Empty
        );
    }

    /// Many sheets naming one large part: each would be walked again.
    fn one_part_many_sheets(sheets: usize, cells: usize) -> Vec<u8> {
        use std::io::Write;
        let part = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{}</row></sheetData></worksheet>"#,
            r#"<c r="A1"/>"#.repeat(cells)
        );
        let list: String = (0..sheets)
            .map(|i| format!(r#"<sheet name="S{i}" sheetId="{}" r:id="rId1"/>"#, i + 1))
            .collect();
        let files = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.to_string(),
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string(),
            ),
            (
                "xl/workbook.xml",
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{list}</sheets></workbook>"#
                ),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string(),
            ),
            ("xl/worksheets/sheet1.xml", part),
        ];
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in files {
            zip.start_file(name, options).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn sheets_sharing_one_part_are_read_once() {
        let input = one_part_many_sheets(1000, 90_000);
        let started = std::time::Instant::now();
        // The part's one row is empty of values: nothing to give, quickly.
        let failure = parse(&input, 100).unwrap_err();
        assert_eq!(failure.code, ErrorCode::Empty);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn the_cell_budget_truncates_instead_of_failing() {
        // More cells than the budget allows, in one sheet: what was read is kept.
        let rows: String = (1..=1_200_000u32)
            .step_by(1)
            .take(1_000_001)
            .map(|r| {
                format!(
                    r#"<row r="{r}"><c r="A{r}"/><c r="B{r}"/><c r="C{r}"/><c r="D{r}"/><c r="E{r}"><v>{r}</v></c></row>"#
                )
            })
            .collect();
        let input = raw_xlsx(&[rows.as_bytes()]);
        let (sheets, _pages, truncated) = parse(&input, 100_000).unwrap();
        assert!(truncated);
        assert!(!sheets[0].rows.is_empty());
    }

    #[test]
    fn output_counts_escaped_bytes() {
        assert_eq!(crate::sheet::json_len(r#"a"b\c"#), 7);
        assert_eq!(crate::sheet::json_len("x\ny"), 8);
    }
}
