//! XLS (Excel 97-2003 BIFF8, and Excel 5/95 BIFF5 workbooks).
//!
//! calamine parses every sheet of an XLS file when it opens it, reserves
//! memory from the declared sheet dimensions and builds each sheet as a
//! dense rectangle, so a tiny file with one cell far from A1 can ask for
//! terabytes. This reader keeps only the cells below the page cap, in a
//! compact form, and renders them row by row.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use encoding_rs::{Encoding, UTF_16LE, WINDOWS_1252};

use crate::cell::{
    MAX_CELL_BYTES, MAX_COLUMNS, clip, excel_datetime, excel_duration, excel_error, number,
};
use crate::output::{ErrorCode, Failure, Sheet};
use crate::sheet::{Flow, MAX_CELLS, SheetsBuilder};

const MALFORMED: Failure = Failure::malformed("the file is not a readable XLS workbook");
const ENCRYPTED: Failure = Failure::new(ErrorCode::Encrypted, "the workbook is password protected");

// BIFF record types (MS-XLS section 2.3).
const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const CONTINUE: u16 = 0x003C;
const FILEPASS: u16 = 0x002F;
const CODEPAGE: u16 = 0x0042;
const DATEMODE: u16 = 0x0022;
const FORMAT: u16 = 0x041E;
const XF: u16 = 0x00E0;
const BOUNDSHEET: u16 = 0x0085;
const SST: u16 = 0x00FC;
const NUMBER: u16 = 0x0203;
const RK: u16 = 0x027E;
const MULRK: u16 = 0x00BD;
const LABEL: u16 = 0x0204;
const RSTRING: u16 = 0x00D6;
const LABELSST: u16 = 0x00FD;
const BOOLERR: u16 = 0x0205;
const FORMULA: u16 = 0x0006;
const STRING: u16 = 0x0207;
/// BOF records of BIFF2, BIFF3 and BIFF4, which we do not read.
const OLD_BOFS: [u16; 3] = [0x0009, 0x0209, 0x0409];

pub(crate) fn parse(input: &[u8], max_pages: u64) -> Result<(Vec<Sheet>, u64, bool), Failure> {
    let mut cfb = cfb::CompoundFile::open(Cursor::new(input)).map_err(|_| MALFORMED)?;
    // A password-protected XLSX is a compound file holding the encrypted
    // package, so it lands here.
    if cfb.is_stream("/EncryptedPackage") || cfb.is_stream("/EncryptionInfo") {
        return Err(ENCRYPTED);
    }
    let name = ["/Workbook", "/Book", "/WORKBOOK", "/BOOK"]
        .into_iter()
        .find(|n| cfb.is_stream(n))
        .ok_or(MALFORMED)?;
    let stream = cfb.open_stream(name).map_err(|_| MALFORMED)?;
    let mut data = Vec::new();
    // A stream cannot hold more sectors than the file; the bound only
    // guards against a container that claims otherwise.
    stream
        .take(input.len() as u64)
        .read_to_end(&mut data)
        .map_err(|_| MALFORMED)?;
    parse_stream(&data, max_pages)
}

pub(crate) fn parse_stream(
    data: &[u8],
    max_pages: u64,
) -> Result<(Vec<Sheet>, u64, bool), Failure> {
    let globals = Globals::read(data)?;
    let mut sheets = SheetsBuilder::new(max_pages);
    // Records read across all sheets. A record takes at least four bytes, so
    // this allows reading the stream twice over; sheets that point into the
    // same region again cannot multiply the work beyond that.
    let mut records_left = data.len() / 2 + 1024;
    for bound in &globals.sheets {
        // Only visible worksheets: charts, macro sheets and VBA modules have
        // no cells, and hidden sheets are left out as in the other formats.
        if bound.kind != 0 || !bound.visible {
            continue;
        }
        if sheets.start_sheet(Some(bound.name.clone())) == Flow::Stop {
            break;
        }
        let Some(start) = usize::try_from(bound.pos).ok().filter(|&p| p < data.len()) else {
            continue;
        };
        let mut kept =
            read_sheet_cells(data, start, &globals, sheets.row_limit(), &mut records_left);
        // Records are mostly in row order already; a stable sort keeps the
        // last of duplicate cells last, so it wins below.
        kept.cells.sort_by_key(|c| (c.row, c.col));
        if emit_cells(&mut sheets, &kept, &globals) == Flow::Stop {
            break;
        }
        if kept.overflow && sheets.overflow() == Flow::Stop {
            break;
        }
        if records_left == 0 {
            sheets.give_up();
            break;
        }
    }
    sheets.finish().ok_or(Failure::new(
        ErrorCode::Empty,
        "the workbook has no cells with values",
    ))
}

fn emit_cells(sheets: &mut SheetsBuilder, kept: &SheetCells, globals: &Globals) -> Flow {
    let mut row: Vec<String> = Vec::new();
    let mut current: Option<u32> = None;
    for cell in &kept.cells {
        match current {
            None => {
                sheets.push_empty_rows(u64::from(cell.row));
                current = Some(cell.row);
            }
            Some(r) if r == cell.row => {}
            Some(r) => {
                if sheets.push_row(std::mem::take(&mut row)) == Flow::Stop {
                    return Flow::Stop;
                }
                sheets.push_empty_rows(u64::from(cell.row - r - 1));
                current = Some(cell.row);
            }
        }
        let col = usize::from(cell.col);
        let value = globals.render(&cell.value, &kept.texts);
        if value.is_empty() {
            // An empty value still replaces an earlier duplicate.
            if let Some(slot) = row.get_mut(col) {
                slot.clear();
            }
            continue;
        }
        if row.len() <= col {
            row.resize(col + 1, String::new());
        }
        row[col] = value;
    }
    if current.is_some() {
        return sheets.push_row(row);
    }
    Flow::Continue
}

/// One cell as read, 24 bytes: a sheet can hold millions of them before
/// the page cap applies, because records may come in any order.
struct RawCell {
    row: u32,
    col: u16,
    value: Value,
}

enum Value {
    Number(f64, u16),
    Sst(u32),
    /// An index into [`SheetCells::texts`].
    Text(u32),
    Bool(bool),
    Error(u8),
}

/// The cells of one sheet that fall within the page cap.
struct SheetCells {
    cells: Vec<RawCell>,
    texts: Vec<String>,
    /// A cell with a value lay past the row limit (or past the cell cap).
    overflow: bool,
    row_limit: u64,
}

impl SheetCells {
    /// Whether a cell at this address is kept. A cell that is not, but has
    /// a value, means the sheet goes on past the cap.
    fn wanted(&mut self, row: u32, col: u16, blank: bool) -> bool {
        if usize::from(col) >= MAX_COLUMNS {
            return false;
        }
        if u64::from(row) >= self.row_limit || self.cells.len() >= MAX_CELLS {
            self.overflow |= !blank;
            return false;
        }
        true
    }

    fn push(&mut self, row: u32, col: u16, value: Value, g: &Globals) {
        let blank = matches!(value, Value::Sst(i) if usize::try_from(i).ok().and_then(|i| g.sst.get(i)).is_none_or(|s| s.is_empty()));
        if self.wanted(row, col, blank) {
            self.cells.push(RawCell { row, col, value });
        }
    }

    fn push_text(&mut self, row: u32, col: u16, text: String) {
        if self.wanted(row, col, text.is_empty()) {
            let index = self.texts.len() as u32;
            self.texts.push(text);
            self.cells.push(RawCell {
                row,
                col,
                value: Value::Text(index),
            });
        }
    }
}

struct BoundSheet {
    pos: u32,
    visible: bool,
    kind: u8,
    name: String,
}

struct Globals {
    biff8: bool,
    is_1904: bool,
    encoding: &'static Encoding,
    formats: HashMap<u16, String>,
    xf_formats: Vec<u16>,
    sst: Vec<String>,
    sheets: Vec<BoundSheet>,
}

impl Globals {
    fn read(data: &[u8]) -> Result<Self, Failure> {
        let mut records = Records::new(data, 0);
        let (typ, bof) = records.next().ok_or(MALFORMED)?;
        if OLD_BOFS.contains(&typ) {
            return Err(Failure::new(
                ErrorCode::Unsupported,
                "Excel 2.x to 4.x workbooks are not supported",
            ));
        }
        if typ != BOF || bof.len() < 4 {
            return Err(MALFORMED);
        }
        let biff8 = match u16_at(bof, 0) {
            Some(0x0600) => true,
            Some(0x0500) => false,
            _ => {
                return Err(Failure::new(
                    ErrorCode::Unsupported,
                    "this Excel version is not supported",
                ));
            }
        };
        let mut g = Globals {
            biff8,
            is_1904: false,
            encoding: WINDOWS_1252,
            formats: HashMap::new(),
            xf_formats: Vec::new(),
            sst: Vec::new(),
            sheets: Vec::new(),
        };
        while let Some((typ, rec)) = records.next() {
            match typ {
                EOF => break,
                FILEPASS => return Err(ENCRYPTED),
                CODEPAGE => {
                    if let Some(cp) = u16_at(rec, 0) {
                        g.encoding = match cp {
                            1200 => UTF_16LE,
                            _ => codepage::to_encoding(cp).unwrap_or(WINDOWS_1252),
                        };
                    }
                }
                DATEMODE => g.is_1904 = u16_at(rec, 0) == Some(1),
                FORMAT => {
                    if let Some(ifmt) = u16_at(rec, 0) {
                        let text = if g.biff8 {
                            unicode_string(rec.get(2..).unwrap_or_default(), 2)
                        } else {
                            g.byte_string(rec.get(2..).unwrap_or_default(), 1)
                        };
                        g.formats.insert(ifmt, text);
                    }
                }
                XF => g.xf_formats.push(u16_at(rec, 2).unwrap_or(0)),
                BOUNDSHEET => {
                    if rec.len() >= 7 {
                        let name = if g.biff8 {
                            unicode_string(&rec[6..], 1)
                        } else {
                            g.byte_string(&rec[6..], 1)
                        };
                        g.sheets.push(BoundSheet {
                            pos: u32_at(rec, 0).unwrap_or(u32::MAX),
                            visible: rec[4] & 0x03 == 0,
                            kind: rec[5],
                            name,
                        });
                    }
                }
                SST => {
                    let mut segments = vec![rec];
                    while let Some(more) = records.next_continue() {
                        segments.push(more);
                    }
                    g.sst = read_sst(&segments);
                }
                _ => {}
            }
        }
        Ok(g)
    }

    /// A BIFF5 string: a length (1 or 2 bytes) and bytes in the workbook's
    /// code page.
    fn byte_string(&self, d: &[u8], len_bytes: usize) -> String {
        let cch = match len_bytes {
            1 => d.first().map(|&b| usize::from(b)),
            _ => u16_at(d, 0).map(usize::from),
        };
        let Some(cch) = cch else {
            return String::new();
        };
        let bytes = &d[len_bytes.min(d.len())..];
        let bytes = &bytes[..cch.min(bytes.len()).min(MAX_CELL_BYTES)];
        self.encoding
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    }

    fn render(&self, value: &Value, texts: &[String]) -> String {
        match value {
            Value::Number(v, ixfe) => {
                let ifmt = self
                    .xf_formats
                    .get(usize::from(*ixfe))
                    .copied()
                    .unwrap_or(0);
                match number_kind(ifmt, &self.formats) {
                    NumberKind::Date => excel_datetime(*v, self.is_1904),
                    NumberKind::Duration => excel_duration(*v),
                    NumberKind::Plain => number(*v),
                }
            }
            Value::Sst(i) => usize::try_from(*i)
                .ok()
                .and_then(|i| self.sst.get(i))
                .map(|s| clip(s))
                .unwrap_or_default(),
            Value::Text(i) => texts.get(*i as usize).map(|s| clip(s)).unwrap_or_default(),
            Value::Bool(b) => b.to_string(),
            Value::Error(code) => excel_error(*code).to_string(),
        }
    }
}

/// Reads the cell records of the worksheet substream at `start`, keeping
/// the cells above `row_limit`.
fn read_sheet_cells(
    data: &[u8],
    start: usize,
    g: &Globals,
    row_limit: u64,
    records_left: &mut usize,
) -> SheetCells {
    let mut kept = SheetCells {
        cells: Vec::new(),
        texts: Vec::new(),
        overflow: false,
        row_limit,
    };
    let mut records = Records::new(data, start);
    match records.next() {
        // A worksheet substream (dt 0x0010). Charts and macro sheets that a
        // BOUNDSHEET called a worksheet are skipped.
        Some((BOF, bof)) if u16_at(bof, 2) == Some(0x0010) => {}
        _ => return kept,
    }
    let mut depth = 0usize;
    let mut pending_string: Option<(u32, u16)> = None;
    for (typ, rec) in records {
        if *records_left == 0 {
            break;
        }
        *records_left -= 1;
        match typ {
            // Embedded charts are substreams of their own inside the sheet.
            BOF => {
                depth += 1;
                continue;
            }
            EOF if depth == 0 => break,
            EOF => {
                depth -= 1;
                continue;
            }
            _ if depth > 0 => continue,
            _ => {}
        }
        if typ == STRING {
            // The cached text result of the FORMULA record before it.
            if let Some((r, c)) = pending_string.take() {
                let text = if g.biff8 {
                    unicode_string(rec, 2)
                } else {
                    g.byte_string(rec, 2)
                };
                kept.push_text(r, c, text);
            }
            continue;
        }
        if !matches!(
            typ,
            NUMBER | RK | MULRK | LABEL | RSTRING | LABELSST | BOOLERR | FORMULA
        ) {
            continue;
        }
        pending_string = None;
        let (Some(row), Some(col)) = (u16_at(rec, 0), u16_at(rec, 2)) else {
            continue;
        };
        let row = u32::from(row);
        let ixfe = u16_at(rec, 4).unwrap_or(0);
        match typ {
            NUMBER => {
                if let Some(v) = f64_at(rec, 6) {
                    kept.push(row, col, Value::Number(v, ixfe), g);
                }
            }
            RK => {
                if let Some(rk) = u32_at(rec, 6) {
                    kept.push(row, col, Value::Number(rk_value(rk), ixfe), g);
                }
            }
            MULRK => {
                // row, first column, then (xf, rk) pairs, then the last column.
                let n = rec.len().saturating_sub(6) / 6;
                for i in 0..n {
                    let (Some(xf), Some(rk)) = (u16_at(rec, 4 + 6 * i), u32_at(rec, 6 + 6 * i))
                    else {
                        break;
                    };
                    let Some(c) = col.checked_add(i as u16) else {
                        break;
                    };
                    kept.push(row, c, Value::Number(rk_value(rk), xf), g);
                }
            }
            LABEL | RSTRING => {
                let body = rec.get(6..).unwrap_or_default();
                let text = if g.biff8 {
                    unicode_string(body, 2)
                } else {
                    g.byte_string(body, 2)
                };
                kept.push_text(row, col, text);
            }
            LABELSST => {
                if let Some(i) = u32_at(rec, 6) {
                    kept.push(row, col, Value::Sst(i), g);
                }
            }
            BOOLERR => {
                if let (Some(&v), Some(&is_error)) = (rec.get(6), rec.get(7)) {
                    let value = if is_error != 0 {
                        Value::Error(v)
                    } else {
                        Value::Bool(v != 0)
                    };
                    kept.push(row, col, value, g);
                }
            }
            FORMULA => {
                let Some(result) = rec.get(6..14) else {
                    continue;
                };
                if result[6..8] == [0xFF, 0xFF] {
                    // Not a number: the first byte says what the cached
                    // result is. A string result follows in a STRING record.
                    match result[0] {
                        0 => pending_string = Some((row, col)),
                        1 => kept.push(row, col, Value::Bool(result[2] != 0), g),
                        2 => kept.push(row, col, Value::Error(result[2]), g),
                        _ => {}
                    }
                } else if let Some(v) = f64_at(rec, 6) {
                    kept.push(row, col, Value::Number(v, ixfe), g);
                }
            }
            _ => {}
        }
    }
    kept
}

/// Decodes an RK number: a 30-bit integer or the top 30 bits of a double,
/// optionally divided by 100.
fn rk_value(rk: u32) -> f64 {
    let v = if rk & 0x02 != 0 {
        f64::from((rk as i32) >> 2)
    } else {
        f64::from_bits(u64::from(rk & 0xFFFF_FFFC) << 32)
    };
    if rk & 0x01 != 0 { v / 100.0 } else { v }
}

/// A BIFF8 unicode string: a length (1 or 2 bytes), an option byte, then
/// either one byte per character (Latin-1) or UTF-16LE. Rich text runs and
/// extended data that may follow are skipped by the caller's framing.
fn unicode_string(d: &[u8], len_bytes: usize) -> String {
    let cch = match len_bytes {
        1 => d.first().map(|&b| usize::from(b)),
        _ => u16_at(d, 0).map(usize::from),
    };
    let (Some(cch), Some(&flags)) = (cch, d.get(len_bytes)) else {
        return String::new();
    };
    let mut pos = len_bytes + 1;
    if flags & 0x08 != 0 {
        pos += 2;
    }
    if flags & 0x04 != 0 {
        pos += 4;
    }
    let chars = d.get(pos..).unwrap_or_default();
    let mut out = String::new();
    decode_chars(chars, cch, flags & 0x01 != 0, &mut out);
    out
}

/// Appends up to `cch` characters from `bytes` and returns how many it
/// consumed. Stops early at the cell size cap; the caller still skips the
/// full character data.
fn decode_chars(bytes: &[u8], cch: usize, wide: bool, out: &mut String) -> usize {
    if wide {
        let n = cch.min(bytes.len() / 2);
        if out.len() < MAX_CELL_BYTES {
            let units = bytes[..n * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c));
            for ch in char::decode_utf16(units) {
                out.push(ch.unwrap_or('\u{FFFD}'));
                if out.len() >= MAX_CELL_BYTES {
                    break;
                }
            }
        }
        n
    } else {
        let n = cch.min(bytes.len());
        if out.len() < MAX_CELL_BYTES {
            for &b in &bytes[..n] {
                out.push(char::from(b));
                if out.len() >= MAX_CELL_BYTES {
                    break;
                }
            }
        }
        n
    }
}

/// Reads the shared string table, whose strings may be split across the
/// SST record and the CONTINUE records after it. A string whose characters
/// cross into a CONTINUE record restarts there with a fresh option byte.
fn read_sst(segments: &[&[u8]]) -> Vec<String> {
    let mut r = Segments {
        segments,
        index: 0,
        pos: 0,
    };
    let (Some(_total), Some(unique)) = (r.u32(), r.u32()) else {
        return Vec::new();
    };
    let available: usize = segments.iter().map(|s| s.len()).sum();
    // Every string takes at least three bytes, which bounds a hostile count.
    let mut strings = Vec::with_capacity((unique as usize).min(available / 3));
    for _ in 0..unique {
        let (Some(cch), Some(flags)) = (r.u16(), r.u8()) else {
            break;
        };
        let runs = if flags & 0x08 != 0 {
            r.u16().unwrap_or(0)
        } else {
            0
        };
        let ext = if flags & 0x04 != 0 {
            r.u32().unwrap_or(0)
        } else {
            0
        };
        let mut text = String::new();
        let mut remaining = usize::from(cch);
        let mut wide = flags & 0x01 != 0;
        while remaining > 0 {
            if r.at_segment_end() {
                if !r.next_segment() {
                    break;
                }
                let Some(f) = r.u8() else { break };
                wide = f & 0x01 != 0;
            }
            let chunk = r.rest_of_segment();
            let used = decode_chars(chunk, remaining, wide, &mut text);
            if used == 0 {
                // An odd byte left for a two-byte character: corrupt.
                return strings;
            }
            r.pos += if wide { used * 2 } else { used };
            remaining -= used;
        }
        r.skip(usize::from(runs) * 4);
        r.skip(ext as usize);
        strings.push(text);
    }
    strings
}

/// A cursor over the SST record and its CONTINUE records.
struct Segments<'a> {
    segments: &'a [&'a [u8]],
    index: usize,
    pos: usize,
}

impl Segments<'_> {
    fn at_segment_end(&self) -> bool {
        self.segments
            .get(self.index)
            .is_none_or(|s| self.pos >= s.len())
    }

    fn next_segment(&mut self) -> bool {
        if self.index + 1 >= self.segments.len() {
            self.index = self.segments.len();
            return false;
        }
        self.index += 1;
        self.pos = 0;
        true
    }

    fn rest_of_segment(&self) -> &[u8] {
        self.segments
            .get(self.index)
            .and_then(|s| s.get(self.pos..))
            .unwrap_or_default()
    }

    /// Reads one byte, moving into the next segment when needed (numbers
    /// may be split without an option byte).
    fn u8(&mut self) -> Option<u8> {
        while self.at_segment_end() {
            if !self.next_segment() {
                return None;
            }
        }
        let b = self.segments[self.index][self.pos];
        self.pos += 1;
        Some(b)
    }

    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes([self.u8()?, self.u8()?]))
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes([
            self.u8()?,
            self.u8()?,
            self.u8()?,
            self.u8()?,
        ]))
    }

    fn skip(&mut self, mut n: usize) {
        while n > 0 {
            if self.at_segment_end() && !self.next_segment() {
                return;
            }
            let take = n.min(self.rest_of_segment().len());
            self.pos += take;
            n -= take;
        }
    }
}

/// Iterates BIFF records from an offset in the workbook stream. A record
/// that runs past the end of the stream ends the iteration.
struct Records<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Records<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    fn peek(&self) -> Option<(u16, &'a [u8], usize)> {
        let typ = u16_at(self.data, self.pos)?;
        let len = usize::from(u16_at(self.data, self.pos + 2)?);
        let start = self.pos + 4;
        let body = self.data.get(start..start + len)?;
        Some((typ, body, start + len))
    }

    fn next_continue(&mut self) -> Option<&'a [u8]> {
        match self.peek()? {
            (CONTINUE, body, end) => {
                self.pos = end;
                Some(body)
            }
            _ => None,
        }
    }
}

impl<'a> Iterator for Records<'a> {
    type Item = (u16, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let (typ, body, end) = self.peek()?;
        self.pos = end;
        Some((typ, body))
    }
}

fn u16_at(d: &[u8], at: usize) -> Option<u16> {
    let b = d.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(d: &[u8], at: usize) -> Option<u32> {
    let b = d.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn f64_at(d: &[u8], at: usize) -> Option<f64> {
    let b = d.get(at..at.checked_add(8)?)?;
    Some(f64::from_le_bytes(b.try_into().ok()?))
}

#[derive(Debug, PartialEq, Eq)]
enum NumberKind {
    Plain,
    Date,
    Duration,
}

/// Whether a number format shows a date, an elapsed time or a plain number.
fn number_kind(ifmt: u16, custom: &HashMap<u16, String>) -> NumberKind {
    if let Some(format) = custom.get(&ifmt) {
        return format_kind(format);
    }
    match ifmt {
        // Built-in date and time formats, including the East Asian ones.
        14..=22 | 27..=36 | 45 | 47 | 50..=58 => NumberKind::Date,
        46 => NumberKind::Duration,
        _ => NumberKind::Plain,
    }
}

/// Classifies a format string by the date and time codes in its first
/// section, ignoring quoted text, escaped characters and bracketed colours
/// and conditions. `[h]`, `[m]` and `[s]` are elapsed-time codes.
fn format_kind(format: &str) -> NumberKind {
    let mut chars = format.chars();
    let mut date = false;
    while let Some(c) = chars.next() {
        match c {
            ';' => break,
            '"' => {
                for q in chars.by_ref() {
                    if q == '"' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                chars.next();
            }
            '[' => {
                let mut inner = String::new();
                for b in chars.by_ref() {
                    if b == ']' {
                        break;
                    }
                    inner.push(b);
                }
                let inner = inner.to_ascii_lowercase();
                if !inner.is_empty() && inner.chars().all(|c| matches!(c, 'h' | 'm' | 's')) {
                    return NumberKind::Duration;
                }
            }
            'd' | 'D' | 'm' | 'M' | 'y' | 'Y' | 'h' | 'H' | 's' | 'S' => date = true,
            _ => {}
        }
    }
    if date {
        NumberKind::Date
    } else {
        NumberKind::Plain
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn rk_numbers() {
        // Integer 5: (5 << 2) | 0x02.
        assert_eq!(rk_value((5 << 2) | 0x02), 5.0);
        // Integer -3, divided by 100.
        assert_eq!(rk_value((((-3i32) << 2) as u32) | 0x03), -0.03);
        // Double 1.5: top 30 bits of its bit pattern.
        let bits = (1.5f64.to_bits() >> 32) as u32;
        assert_eq!(rk_value(bits), 1.5);
    }

    #[test]
    fn format_kinds() {
        assert_eq!(format_kind("General"), NumberKind::Plain);
        assert_eq!(format_kind("0.00"), NumberKind::Plain);
        assert_eq!(format_kind("#,##0.00 \"days\""), NumberKind::Plain);
        assert_eq!(format_kind("[Red]0.00"), NumberKind::Plain);
        assert_eq!(format_kind("yyyy-mm-dd"), NumberKind::Date);
        assert_eq!(format_kind("h:mm AM/PM"), NumberKind::Date);
        assert_eq!(format_kind("[h]:mm:ss"), NumberKind::Duration);
        assert_eq!(format_kind("0.00E+00"), NumberKind::Plain);
        assert_eq!(format_kind("0;\"neg\" dd"), NumberKind::Plain);
        assert_eq!(number_kind(14, &HashMap::new()), NumberKind::Date);
        assert_eq!(number_kind(46, &HashMap::new()), NumberKind::Duration);
        assert_eq!(number_kind(2, &HashMap::new()), NumberKind::Plain);
    }

    #[test]
    fn sst_strings_split_across_continue_records() {
        // Two strings: "abc" compressed, then "héllo" as UTF-16 split after
        // two characters, continuing compressed (option byte 0) in the next
        // record.
        let mut first = Vec::new();
        first.extend_from_slice(&2u32.to_le_bytes());
        first.extend_from_slice(&2u32.to_le_bytes());
        first.extend_from_slice(&3u16.to_le_bytes());
        first.push(0x00);
        first.extend_from_slice(b"abc");
        first.extend_from_slice(&5u16.to_le_bytes());
        first.push(0x01);
        for u in "hé".encode_utf16() {
            first.extend_from_slice(&u.to_le_bytes());
        }
        let mut second = vec![0x00];
        second.extend_from_slice(b"llo");
        let strings = read_sst(&[&first, &second]);
        assert_eq!(strings, vec!["abc".to_string(), "héllo".to_string()]);
    }

    #[test]
    fn sst_with_a_hostile_count_stops_at_the_data() {
        let mut first = Vec::new();
        first.extend_from_slice(&u32::MAX.to_le_bytes());
        first.extend_from_slice(&u32::MAX.to_le_bytes());
        first.extend_from_slice(&1u16.to_le_bytes());
        first.push(0x00);
        first.push(b'x');
        assert_eq!(read_sst(&[&first]), vec!["x".to_string()]);
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;
    use crate::testutil::{Xls, compound_file, record};

    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    fn rk_rows(n: u16) -> Vec<u8> {
        (0..n)
            .flat_map(|r| Xls::rk_int(r, 0, 0, i32::from(r)))
            .collect()
    }

    #[test]
    fn values_of_every_type() {
        let book = Xls {
            sst: vec!["Name".into(), "Größe ✓".into()],
            formats: vec![(164, "yyyy-mm-dd hh:mm".into()), (165, "[h]:mm".into())],
            // XF 0 general, 1 built-in date (14), 2 custom datetime, 3 elapsed.
            xfs: vec![0, 14, 164, 165],
            sheets: vec![(
                "Data".into(),
                0,
                [
                    Xls::sst_cell(0, 0, 0),
                    Xls::sst_cell(0, 1, 1),
                    Xls::number(1, 0, 0, 1.0),
                    Xls::number(1, 1, 0, 2.5),
                    Xls::rk_int(1, 2, 0, -7),
                    Xls::number(2, 0, 1, 46324.0),
                    Xls::number(2, 1, 2, 46324.5),
                    Xls::number(2, 2, 3, 1.5),
                    Xls::mulrk(3, 1, &[10, 20, 30]),
                    Xls::label(4, 0, "plain label"),
                    Xls::boolerr(4, 1, 1, false),
                    Xls::boolerr(4, 2, 0x07, true),
                    Xls::formula_number(5, 0, 0.1 + 0.2),
                    Xls::formula_text(5, 1, "from a formula"),
                ]
                .concat(),
            )],
            ..Xls::default()
        };
        let (sheets, pages, truncated) = parse(&book.build(), 100).unwrap();
        assert_eq!((pages, truncated), (1, false));
        assert_eq!(sheets[0].name.as_deref(), Some("Data"));
        assert_eq!(
            sheets[0].rows,
            strings(&[
                &["Name", "Größe ✓"],
                &["1", "2.5", "-7"],
                &["2026-10-29", "2026-10-29T12:00:00", "PT36H00M00S"],
                &["", "10", "20", "30"],
                &["plain label", "true", "#DIV/0!"],
                &["0.3", "from a formula"],
            ])
        );
    }

    #[test]
    fn the_1904_date_system() {
        let book = Xls {
            xfs: vec![0, 14],
            date1904: true,
            sheets: vec![("S".into(), 0, Xls::number(0, 0, 1, 44862.0))],
            ..Xls::default()
        };
        let (sheets, _, _) = parse(&book.build(), 100).unwrap();
        assert_eq!(sheets[0].rows, strings(&[&["2026-10-29"]]));
    }

    #[test]
    fn shared_strings_split_by_continue_records() {
        let book = Xls {
            sst: (0..200).map(|i| format!("string number {i}")).collect(),
            sst_split: Some(120),
            sheets: vec![(
                "S".into(),
                0,
                [Xls::sst_cell(0, 0, 0), Xls::sst_cell(1, 0, 199)].concat(),
            )],
            ..Xls::default()
        };
        let (sheets, _, _) = parse(&book.build(), 100).unwrap();
        assert_eq!(
            sheets[0].rows,
            strings(&[&["string number 0"], &["string number 199"]])
        );
    }

    #[test]
    fn hidden_sheets_are_left_out() {
        let book = Xls {
            sheets: vec![
                ("Shown".into(), 0, Xls::label(0, 0, "a")),
                ("Hidden".into(), 1, Xls::label(0, 0, "b")),
                ("VeryHidden".into(), 2, Xls::label(0, 0, "c")),
            ],
            ..Xls::default()
        };
        let (sheets, _, _) = parse(&book.build(), 100).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name.as_deref(), Some("Shown"));
    }

    #[test]
    fn out_of_order_and_duplicate_cells_are_placed_by_address() {
        let book = Xls {
            sheets: vec![(
                "S".into(),
                0,
                [
                    Xls::label(2, 0, "third"),
                    Xls::label(0, 1, "first"),
                    Xls::label(0, 1, "replaced"),
                    Xls::label(1, 0, "second"),
                ]
                .concat(),
            )],
            ..Xls::default()
        };
        let (sheets, _, _) = parse(&book.build(), 100).unwrap();
        assert_eq!(
            sheets[0].rows,
            strings(&[&["", "replaced"], &["second"], &["third"]])
        );
    }

    #[test]
    fn far_apart_cells_do_not_allocate_the_rectangle_between_them() {
        let book = Xls {
            sheets: vec![(
                "S".into(),
                0,
                [Xls::label(0, 0, "a"), Xls::label(65_535, 255, "z")].concat(),
            )],
            ..Xls::default()
        };
        let (sheets, pages, truncated) = parse(&book.build(), 100).unwrap();
        assert!(!truncated);
        assert_eq!(pages, 66);
        assert_eq!(sheets[0].row_count, 65_536);
        assert_eq!(sheets[0].rows[65_535].len(), 256);
        let (sheets, pages, truncated) = parse(&book.build(), 1).unwrap();
        assert!(truncated);
        assert_eq!(pages, 1);
        assert_eq!(sheets[0].row_count, 1);
    }

    #[test]
    fn page_counts_and_the_cap() {
        for (n, pages) in [(1u16, 1u64), (999, 1), (1000, 1), (1001, 2), (2000, 2)] {
            let book = Xls {
                sheets: vec![("S".into(), 0, rk_rows(n))],
                ..Xls::default()
            };
            let (_, used, truncated) = parse(&book.build(), 100).unwrap();
            assert_eq!(used, pages, "{n} rows");
            assert!(!truncated);
        }
        let book = Xls {
            sheets: vec![
                ("A".into(), 0, rk_rows(1500)),
                ("B".into(), 0, rk_rows(1500)),
                ("C".into(), 0, rk_rows(1)),
            ],
            ..Xls::default()
        };
        let (sheets, pages, truncated) = parse(&book.build(), 3).unwrap();
        assert!(truncated);
        assert_eq!(pages, 3);
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[1].row_count, 1000);
    }

    #[test]
    fn password_protection_is_reported() {
        let mut stream = record(0x0809, &[0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0]);
        stream.extend(record(0x002F, &[1, 0, 0, 0]));
        stream.extend(record(0x000A, &[]));
        let file = compound_file(&[("/Workbook", &stream)]);
        assert_eq!(parse(&file, 100).unwrap_err().code, ErrorCode::Encrypted);
    }

    #[test]
    fn biff5_workbooks_use_the_code_page() {
        let mut stream = record(0x0809, &[0x00, 0x05, 0x05, 0x00, 0, 0, 0, 0]);
        stream.extend(record(0x0042, &1252u16.to_le_bytes()));
        let sheet_record_at = stream.len() + 4;
        stream.extend(record(
            0x0085,
            &[0, 0, 0, 0, 0, 0, 5, b'B', b'l', b'a', b't', b't'],
        ));
        stream.extend(record(0x000A, &[]));
        let pos = stream.len() as u32;
        stream[sheet_record_at..sheet_record_at + 4].copy_from_slice(&pos.to_le_bytes());
        stream.extend(record(0x0809, &[0x00, 0x05, 0x10, 0x00, 0, 0, 0, 0]));
        let mut label = vec![0, 0, 0, 0, 0, 0];
        label.extend_from_slice(&4u16.to_le_bytes());
        label.extend_from_slice(b"caf\xE9");
        stream.extend(record(0x0204, &label));
        stream.extend(record(0x000A, &[]));
        let (sheets, _, _) = parse(&compound_file(&[("/Book", &stream)]), 100).unwrap();
        assert_eq!(sheets[0].name.as_deref(), Some("Blatt"));
        assert_eq!(sheets[0].rows, strings(&[&["café"]]));
    }

    #[test]
    fn old_and_broken_files() {
        let biff4 = compound_file(&[("/Workbook", &record(0x0409, &[0; 6]))]);
        assert_eq!(parse(&biff4, 100).unwrap_err().code, ErrorCode::Unsupported);
        let no_workbook = compound_file(&[("/Other", b"x")]);
        assert_eq!(
            parse(&no_workbook, 100).unwrap_err().code,
            ErrorCode::Malformed
        );
        let garbage = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1garbage";
        assert_eq!(parse(garbage, 100).unwrap_err().code, ErrorCode::Malformed);
        let empty = Xls {
            sheets: vec![("S".into(), 0, Vec::new())],
            ..Xls::default()
        };
        assert_eq!(
            parse(&empty.build(), 100).unwrap_err().code,
            ErrorCode::Empty
        );
    }

    #[test]
    fn many_sheets_sharing_one_long_substream_do_not_multiply_the_work() {
        // Two thousand sheets all point at one substream of a hundred
        // thousand records that carry no values.
        let mut stream = record(0x0809, &[0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0]);
        let mut positions = Vec::new();
        for i in 0..2000u32 {
            positions.push(stream.len() + 4);
            let name = format!("s{i}");
            let mut d = vec![0, 0, 0, 0, 0, 0, name.len() as u8, 0];
            d.extend_from_slice(name.as_bytes());
            stream.extend(record(0x0085, &d));
        }
        stream.extend(record(0x000A, &[]));
        let pos = (stream.len() as u32).to_le_bytes();
        for at in positions {
            stream[at..at + 4].copy_from_slice(&pos);
        }
        stream.extend(record(0x0809, &[0x00, 0x06, 0x10, 0x00, 0, 0, 0, 0]));
        for _ in 0..100_000 {
            stream.extend(record(0x0201, &[0; 6]));
        }
        stream.extend(record(0x000A, &[]));
        let started = std::time::Instant::now();
        let (_, pages, truncated) = parse_stream(&stream, 100).unwrap();
        assert!(truncated);
        assert_eq!(pages, 0);
        assert!(started.elapsed().as_secs() < 10, "{:?}", started.elapsed());
    }

    #[test]
    fn a_truncated_stream_keeps_what_it_can_read() {
        let book = Xls {
            sheets: vec![(
                "S".into(),
                0,
                [Xls::label(0, 0, "kept"), Xls::label(1, 0, "lost")].concat(),
            )],
            ..Xls::default()
        };
        let mut stream = book.stream();
        stream.truncate(stream.len() - 10);
        let (sheets, _, _) = parse_stream(&stream, 100).unwrap();
        assert_eq!(sheets[0].rows, strings(&[&["kept"]]));
    }
}
