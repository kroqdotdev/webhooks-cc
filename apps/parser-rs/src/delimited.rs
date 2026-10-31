//! CSV and TSV.

use crate::cell::MAX_COLUMNS;
use crate::decode::decode_text;
use crate::output::{ErrorCode, Failure, Sheet};
use crate::sheet::{Flow, SheetsBuilder};

/// Delimiters we detect, in the order that wins a tie. Tabs and pipes almost
/// never occur inside values, and a semicolon file often has decimal commas
/// in every row, so comma loses ties.
const CANDIDATES: [u8; 4] = *b"\t|;,";
/// How much of the file the delimiter detection looks at.
const SNIFF_BYTES: usize = 64 * 1024;
const SNIFF_RECORDS: usize = 50;

pub(crate) type Parsed = (Vec<Sheet>, u64, bool);

/// Parses delimited text into one unnamed sheet. `tab` forces a tab
/// delimiter (TSV); otherwise it is detected.
pub(crate) fn parse(input: &[u8], tab: bool, max_pages: u64) -> Result<Parsed, Failure> {
    let text = decode_text(input);
    let delimiter = if tab { b'\t' } else { detect_delimiter(&text) };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(text.as_bytes());

    let mut sheets = SheetsBuilder::new(max_pages);
    sheets.start_sheet(None);
    let mut record = csv::ByteRecord::new();
    // Reading from memory, the only errors are about the input, and with
    // `flexible` set none is worth losing the rows already read for.
    while let Ok(true) = reader.read_byte_record(&mut record) {
        let cells = record
            .iter()
            .take(MAX_COLUMNS)
            .map(|field| String::from_utf8_lossy(field).into_owned())
            .collect();
        if sheets.push_row(cells) == Flow::Stop {
            break;
        }
    }
    sheets
        .finish()
        .ok_or(Failure::new(ErrorCode::Empty, "the file has no rows"))
}

/// Picks the delimiter that splits the first records most consistently:
/// the one for which the most records share the same (non-zero) number of
/// delimiters. Quoted sections are skipped, so commas inside quoted values
/// do not count.
pub(crate) fn detect_delimiter(text: &str) -> u8 {
    let mut sample = &text.as_bytes()[..text.len().min(SNIFF_BYTES)];
    let cut = text.len() > SNIFF_BYTES;
    if cut {
        // Ignore the record the sample cut in half.
        if let Some(end) = sample.iter().rposition(|&b| b == b'\n') {
            sample = &sample[..end];
        }
    }
    let mut best: Option<(usize, u8)> = None;
    for &candidate in &CANDIDATES {
        let (mode, freq) = mode_of(&delimiter_counts(sample, candidate));
        if mode == 0 {
            continue;
        }
        // Candidates are in preference order, so only a strictly more
        // consistent one replaces the current best.
        if best.is_none_or(|(best_freq, _)| freq > best_freq) {
            best = Some((freq, candidate));
        }
    }
    best.map_or(b',', |(_, candidate)| candidate)
}

/// Delimiters outside quotes for each of the first records.
fn delimiter_counts(sample: &[u8], delimiter: u8) -> Vec<usize> {
    let mut counts = Vec::new();
    let mut count = 0usize;
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut i = 0;
    while i < sample.len() && counts.len() < SNIFF_RECORDS {
        let b = sample[i];
        if in_quotes {
            if b == b'"' {
                if sample.get(i + 1) == Some(&b'"') {
                    i += 1;
                } else {
                    in_quotes = false;
                }
            }
        } else if b == b'"' && at_field_start {
            in_quotes = true;
        } else if b == delimiter {
            count += 1;
            at_field_start = true;
            i += 1;
            continue;
        } else if b == b'\n' || b == b'\r' {
            if b == b'\r' && sample.get(i + 1) == Some(&b'\n') {
                i += 1;
            }
            counts.push(count);
            count = 0;
            at_field_start = true;
            i += 1;
            continue;
        }
        at_field_start = false;
        i += 1;
    }
    if (count > 0 || !at_field_start) && counts.len() < SNIFF_RECORDS {
        counts.push(count);
    }
    counts
}

/// The most common value and how often it occurs. Larger values win ties.
fn mode_of(counts: &[usize]) -> (usize, usize) {
    let mut sorted = counts.to_vec();
    sorted.sort_unstable();
    let mut best = (0usize, 0usize);
    let mut i = 0;
    while i < sorted.len() {
        let value = sorted[i];
        let mut j = i;
        while j < sorted.len() && sorted[j] == value {
            j += 1;
        }
        let freq = j - i;
        if value > 0 && (freq, value) > (best.1, best.0) {
            best = (value, freq);
        }
        i = j;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(input: &str) -> Vec<Vec<String>> {
        let (sheets, _, _) = parse(input.as_bytes(), false, 100).unwrap();
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].name, None);
        sheets[0].rows.clone()
    }

    fn strings(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    #[test]
    fn detects_each_delimiter() {
        assert_eq!(detect_delimiter("a,b,c\n1,2,3\n"), b',');
        assert_eq!(detect_delimiter("a;b;c\n1;2;3\n"), b';');
        assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3\n"), b'\t');
        assert_eq!(detect_delimiter("a|b|c\n1|2|3\n"), b'|');
        assert_eq!(detect_delimiter("single column\nvalue\n"), b',');
    }

    #[test]
    fn semicolons_beat_decimal_commas() {
        assert_eq!(detect_delimiter("name;amount\nfoo;1,5\nbar;2,25\n"), b';');
        assert_eq!(detect_delimiter("1,5;2,3\n4,5;6,7\n"), b';');
    }

    #[test]
    fn quoted_delimiters_do_not_count() {
        let text = "name,comment\n\"Smith; John\",\"a; b; c\"\n\"Doe; Jane\",\"x\"\n";
        assert_eq!(detect_delimiter(text), b',');
    }

    #[test]
    fn parses_quotes_crlf_bom_and_ragged_rows() {
        let input = "\u{feff}a,\"b,c\",\"d \"\"q\"\"\"\r\n1,2\r\n\"multi\nline\",x,y,z\r\n";
        assert_eq!(
            rows(input),
            strings(&[
                &["a", "b,c", "d \"q\""],
                &["1", "2"],
                &["multi\nline", "x", "y", "z"],
            ])
        );
    }

    #[test]
    fn tsv_forces_tabs() {
        let (sheets, pages, _) = parse(b"a,b\tc\n1,2\t3\n", true, 100).unwrap();
        assert_eq!(pages, 1);
        assert_eq!(sheets[0].rows, strings(&[&["a,b", "c"], &["1,2", "3"]]));
    }

    #[test]
    fn trailing_empty_cells_and_rows_are_dropped() {
        assert_eq!(
            rows("a,b,,\n,,,\n1,,2,\n,,\n\n"),
            strings(&[&["a", "b"], &[], &["1", "", "2"]])
        );
    }

    #[test]
    fn invalid_utf8_falls_back_to_windows_1252() {
        assert_eq!(rows("caf\u{e9};1\n"), strings(&[&["café", "1"]]));
        let (sheets, _, _) = parse(b"caf\xE9;1\nna\xEFve;2\n", false, 100).unwrap();
        assert_eq!(sheets[0].rows, strings(&[&["café", "1"], &["naïve", "2"]]));
    }

    #[test]
    fn utf16_excel_unicode_text() {
        let mut input = b"\xFF\xFE".to_vec();
        for unit in "a\tb\r\n1\t2\r\n".encode_utf16() {
            input.extend_from_slice(&unit.to_le_bytes());
        }
        let (sheets, _, _) = parse(&input, false, 100).unwrap();
        assert_eq!(sheets[0].rows, strings(&[&["a", "b"], &["1", "2"]]));
    }

    #[test]
    fn empty_input_is_empty() {
        for input in ["", "\n\n", ",,,\n,,\n", "\u{feff}"] {
            assert_eq!(
                parse(input.as_bytes(), false, 100).unwrap_err().code,
                ErrorCode::Empty,
                "{input:?}"
            );
        }
    }

    #[test]
    fn unterminated_quote_keeps_the_rest_as_one_clipped_cell() {
        let input = format!("a,\"{}\n", "x".repeat(100_000));
        let r = rows(&input);
        assert_eq!(r[0][0], "a");
        assert_eq!(r[0][1].len(), crate::cell::MAX_CELL_BYTES);
    }

    #[test]
    fn rows_are_capped_by_pages() {
        let input = "x,1\n".repeat(5000);
        let (sheets, pages, truncated) = parse(input.as_bytes(), false, 2).unwrap();
        assert_eq!(pages, 2);
        assert!(truncated);
        assert_eq!(sheets[0].row_count, 2000);
    }

    #[test]
    fn page_counts_for_row_totals() {
        for (n, pages) in [(1, 1), (999, 1), (1000, 1), (1001, 2), (2000, 2)] {
            let input = "a\n".repeat(n);
            let (_, used, truncated) = parse(input.as_bytes(), false, 100).unwrap();
            assert_eq!(used, pages, "{n} rows");
            assert!(!truncated);
        }
    }
}
