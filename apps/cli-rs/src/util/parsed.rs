//! The human view of a captured email's parsed result (`parsed`: what the
//! endpoint's layouts found). `whk requests get` prints these lines with ANSI
//! colours and the TUI's request view draws them with its theme, so both say
//! the same thing; the wording follows the dashboard's parsed tab.
//!
//! A parsed result comes from the email and its attachments, which the sender
//! wrote, so every value goes through `sanitize_line` and is cut to a width
//! that keeps the view inside an ordinary terminal.

use std::collections::BTreeSet;

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::cli::output::sanitize_line;
use crate::types::{ParsedAttachment, ParsedEmail};
use crate::util::format::format_bytes;

/// Line items shown, as many as the dashboard shows; the rest are counted.
pub const MAX_LINE_ITEM_ROWS: usize = 50;
/// A line item cell or column name, in terminal columns.
const MAX_CELL_WIDTH: usize = 24;
/// The line items table, in terminal columns: with its indent it fits a
/// 100-column terminal, and columns past it are counted instead of wrapped.
const MAX_TABLE_WIDTH: usize = 92;
/// A field's value or the layout's name, in terminal columns.
const MAX_VALUE_WIDTH: usize = 80;
/// A field's or an attachment's name, in terminal columns.
const MAX_NAME_WIDTH: usize = 48;
/// Between two columns of the line items table.
const GAP: &str = "  ";

/// How a piece of a line is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Plain,
    Strong,
    Muted,
    Danger,
}

/// One line under the "Parsed" heading: how deep it sits (0 directly under
/// the heading, 1 inside a subsection) and its pieces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLine {
    pub depth: usize,
    pub spans: Vec<(Tone, String)>,
}

impl ParsedLine {
    fn new(depth: usize, spans: Vec<(Tone, String)>) -> Self {
        Self { depth, spans }
    }

    /// The line's text, without its indent or colours.
    pub fn text(&self) -> String {
        self.spans.iter().map(|(_, text)| text.as_str()).collect()
    }
}

/// The lines under an email's "Parsed" heading: the layout, its fields, the
/// line items as a table in `lineItemColumns` order, and one line per parsed
/// attachment.
pub fn parsed_lines(parsed: &ParsedEmail) -> Vec<ParsedLine> {
    if !parsed.matched() {
        return vec![ParsedLine::new(
            0,
            vec![(Tone::Danger, "No layout matched this email.".into())],
        )];
    }
    let mut lines = Vec::new();
    let layout = parsed
        .layout
        .as_ref()
        .map(|layout| layout.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("(unnamed)");
    lines.push(pair(
        "Layout",
        clip(&sanitize_line(layout), MAX_VALUE_WIDTH),
    ));
    if parsed.pages > 0 {
        lines.push(pair("Pages", parsed.pages.to_string()));
    }
    if parsed.truncated {
        lines.push(note(
            0,
            "Cut to fit the email's JSON; the full parse is kept.",
        ));
    }

    if !parsed.fields.is_empty() {
        lines.push(title("Fields"));
        for (name, value) in &parsed.fields {
            let value = match value {
                Some(value) => (Tone::Plain, clip(&sanitize_line(value), MAX_VALUE_WIDTH)),
                None => (Tone::Danger, "not found".into()),
            };
            lines.push(ParsedLine::new(
                1,
                vec![
                    (Tone::Strong, clip(&sanitize_line(name), MAX_NAME_WIDTH)),
                    (Tone::Muted, ": ".into()),
                    value,
                ],
            ));
        }
    }

    line_items(parsed, &mut lines);

    if !parsed.attachments.is_empty() {
        lines.push(title("Attachments"));
        for attachment in &parsed.attachments {
            lines.push(attachment_line(attachment));
        }
    }

    if parsed.partial {
        lines.push(note(
            0,
            "Lists leave out line items and attachments; get the request for all of it.",
        ));
    }
    lines
}

/// The line items as a table: a muted header row, then a row per item.
fn line_items(parsed: &ParsedEmail, lines: &mut Vec<ParsedLine>) {
    if parsed.line_items.is_empty() {
        return;
    }
    lines.push(title(&format!("Line items ({})", parsed.line_items.len())));

    // The columns come in `lineItemColumns` order; without it, every key any
    // row has, sorted, since the rows' own key order is lost.
    let columns: Vec<&str> = if parsed.line_item_columns.is_empty() {
        let keys: BTreeSet<&str> = parsed
            .line_items
            .iter()
            .flat_map(|row| row.keys().map(String::as_str))
            .collect();
        keys.into_iter().collect()
    } else {
        parsed
            .line_item_columns
            .iter()
            .map(String::as_str)
            .collect()
    };
    let shown = &parsed.line_items[..parsed.line_items.len().min(MAX_LINE_ITEM_ROWS)];

    let header: Vec<String> = columns
        .iter()
        .map(|column| clip(&sanitize_line(column), MAX_CELL_WIDTH))
        .collect();
    let rows: Vec<Vec<String>> = shown
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|column| match row.get(*column) {
                    Some(Some(value)) => clip(&sanitize_line(value), MAX_CELL_WIDTH),
                    _ => String::new(),
                })
                .collect()
        })
        .collect();

    let mut widths: Vec<usize> = header.iter().map(|cell| cell.width()).collect();
    for row in &rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.width());
        }
    }
    // As many columns as fit, and always the first.
    let mut used = 0;
    let mut fit = 0;
    for (i, width) in widths.iter().enumerate() {
        let needed = if i == 0 { *width } else { width + GAP.len() };
        if fit > 0 && used + needed > MAX_TABLE_WIDTH {
            break;
        }
        used += needed;
        fit += 1;
    }

    lines.push(ParsedLine::new(
        1,
        vec![(Tone::Muted, table_row(&header[..fit], &widths))],
    ));
    for row in &rows {
        lines.push(ParsedLine::new(
            1,
            vec![(Tone::Plain, table_row(&row[..fit], &widths))],
        ));
    }
    let hidden = columns.len() - fit;
    if hidden > 0 {
        lines.push(note(
            1,
            &format!("{} in the JSON.", plural(hidden as u64, "more column")),
        ));
    }
    let more = parsed.line_items.len() - shown.len();
    if more > 0 {
        lines.push(note(
            1,
            &format!("{} in the JSON.", plural(more as u64, "more line item")),
        ));
    }
}

/// Cells padded to their column's width and joined, without trailing spaces.
fn table_row(cells: &[String], widths: &[usize]) -> String {
    let mut out = String::new();
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.push_str(GAP);
        }
        out.push_str(cell);
        out.push_str(&" ".repeat(widths[i].saturating_sub(cell.width())));
    }
    out.trim_end().to_string()
}

/// One parsed attachment: its name, its format and what became of it.
fn attachment_line(attachment: &ParsedAttachment) -> ParsedLine {
    let name = match attachment
        .filename
        .as_deref()
        .filter(|name| !name.is_empty())
    {
        Some(name) => clip(&sanitize_line(name), MAX_NAME_WIDTH),
        None => format!("attachment {}", attachment.index + 1),
    };
    let format = match attachment.format.as_str() {
        "" => "file".to_string(),
        format => clip(&sanitize_line(format), MAX_CELL_WIDTH),
    };
    let (tone, outcome) = match attachment.error.as_deref() {
        // A preview never parses; that is not a failure.
        Some("not_parsed") => (Tone::Muted, error_note("not_parsed")),
        Some(code) => (Tone::Danger, error_note(code)),
        None => (Tone::Muted, parse_note(attachment)),
    };
    ParsedLine::new(
        1,
        vec![
            (Tone::Plain, name),
            (Tone::Plain, GAP.into()),
            (tone, format!("{format}, {outcome}")),
        ],
    )
}

/// Why an attachment was not parsed, in the dashboard's words.
fn error_note(code: &str) -> String {
    match code {
        "limit" => "not parsed: no pages left this month".into(),
        "not_kept" => "not parsed: its contents were not kept".into(),
        "not_parsed" => "parsed when an email arrives (the preview never parses)".into(),
        "too_large" => "not parsed: larger than 32 MB".into(),
        "malformed" => "could not be read".into(),
        "encrypted" => "is encrypted".into(),
        "zip_bomb" => "refused: it expands too far".into(),
        "empty" => "is empty".into(),
        other => format!(
            "not parsed: {}",
            clip(&sanitize_line(other), MAX_CELL_WIDTH)
        ),
    }
}

/// A parsed attachment's pages, sheets and rows, or the size of its text.
fn parse_note(attachment: &ParsedAttachment) -> String {
    let mut parts = Vec::new();
    if attachment.pages == 0 {
        // A stored parse read again (a replay or the preview) uses no pages.
        parts.push("parsed before, no pages used".to_string());
    } else {
        parts.push(plural(attachment.pages, "page"));
    }
    if let Some(sheets) = &attachment.sheets {
        let rows: u64 = sheets.iter().map(|sheet| sheet.row_count).sum();
        parts.push(plural(sheets.len() as u64, "sheet"));
        parts.push(plural(rows, "row"));
    }
    if let Some(text) = &attachment.text {
        parts.push(format!("{} of text", format_bytes(text.len())));
    }
    if attachment.truncated {
        parts.push("cut off at the limit".into());
    }
    parts.join(", ")
}

fn pair(label: &str, value: String) -> ParsedLine {
    ParsedLine::new(
        0,
        vec![(Tone::Muted, format!("{label}: ")), (Tone::Plain, value)],
    )
}

fn title(text: &str) -> ParsedLine {
    ParsedLine::new(0, vec![(Tone::Strong, text.into())])
}

fn note(depth: usize, text: &str) -> ParsedLine {
    ParsedLine::new(depth, vec![(Tone::Muted, text.into())])
}

/// `1 page`, `3 pages`; `what` is singular.
fn plural(n: u64, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else {
        format!("{n} {what}s")
    }
}

/// `text` in at most `max` terminal columns, ending in "..." when cut.
fn clip(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_string();
    }
    let room = max.saturating_sub(3);
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let width = c.width().unwrap_or(0);
        if used + width > room {
            break;
        }
        used += width;
        out.push(c);
    }
    out.push_str("...");
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::types::CapturedRequest;

    /// An email on an endpoint with an Acme orders layout, as
    /// `GET /api/requests/{id}` sends it.
    pub(crate) const ACME_ORDER_EMAIL: &str = r#"{
        "id": "req-acme-1001",
        "endpointId": "ep-acme",
        "method": "EMAIL",
        "path": "orders@mailhooks.cc",
        "headers": {"subject": "Order 1001"},
        "body": "raw",
        "queryParams": {},
        "ip": "192.0.2.1",
        "size": 2048,
        "receivedAt": 1700000000000,
        "kind": "email",
        "email": {
            "subject": "Order 1001",
            "from": [{"name": "Acme Orders", "address": "orders@acme.example"}],
            "to": [{"name": null, "address": "orders@mailhooks.cc"}],
            "tag": null,
            "text": "Order 1001",
            "attachments": [
                {"filename": "order-1001.csv", "contentType": "text/csv", "size": 64},
                {"filename": "terms.pdf", "contentType": "application/pdf", "size": 4096},
                {"filename": "scan.pdf", "contentType": "application/pdf", "size": 9000}
            ]
        },
        "parsed": {
            "status": "matched",
            "layout": {"id": "orders", "name": "Acme orders"},
            "fields": {"order": "1001", "po": null},
            "lineItems": [
                {"sku": "A-1", "qty": "2", "price": "9.50"},
                {"sku": "B-7", "qty": "1", "price": "24.00"}
            ],
            "lineItemColumns": ["sku", "qty", "price"],
            "attachments": [
                {
                    "index": 0,
                    "filename": "order-1001.csv",
                    "format": "csv",
                    "pages": 1,
                    "sheets": [
                        {
                            "name": null,
                            "rows": [["sku", "qty", "price"], ["A-1", "2", "9.50"], ["B-7", "1", "24.00"]],
                            "rowCount": 3,
                            "truncated": false
                        }
                    ],
                    "truncated": false,
                    "error": null
                },
                {
                    "index": 1,
                    "filename": "terms.pdf",
                    "format": "pdf",
                    "pages": 2,
                    "text": "Acme terms of sale",
                    "truncated": false,
                    "error": null
                },
                {
                    "index": 2,
                    "filename": "scan.pdf",
                    "format": "pdf",
                    "pages": 0,
                    "truncated": false,
                    "error": "encrypted"
                }
            ],
            "pages": 3
        }
    }"#;

    pub(crate) fn acme_order() -> CapturedRequest {
        serde_json::from_str(ACME_ORDER_EMAIL).unwrap()
    }

    fn texts(parsed: &ParsedEmail) -> Vec<String> {
        parsed_lines(parsed)
            .iter()
            .map(|line| format!("{}{}", "  ".repeat(line.depth), line.text()))
            .collect()
    }

    #[test]
    fn shows_the_layout_fields_line_items_and_attachments() {
        let parsed = acme_order().parsed.unwrap();
        assert_eq!(
            texts(&parsed),
            [
                "Layout: Acme orders",
                "Pages: 3",
                "Fields",
                "  order: 1001",
                "  po: not found",
                "Line items (2)",
                "  sku  qty  price",
                "  A-1  2    9.50",
                "  B-7  1    24.00",
                "Attachments",
                "  order-1001.csv  csv, 1 page, 1 sheet, 3 rows",
                "  terms.pdf  pdf, 2 pages, 18 B of text",
                "  scan.pdf  pdf, is encrypted",
            ]
        );
        let lines = parsed_lines(&parsed);
        // A field the layout did not find, and a file that was not read, stand out.
        assert_eq!(lines[4].spans[2], (Tone::Danger, "not found".to_string()));
        assert_eq!(lines[12].spans[2].0, Tone::Danger);
        assert_eq!(lines[6].spans[0].0, Tone::Muted);
    }

    #[test]
    fn no_layout_is_one_line() {
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"no_layout","layout":null,"fields":{},"lineItems":[],"lineItemColumns":[],"attachments":[],"pages":0}"#,
        )
        .unwrap();
        assert_eq!(texts(&parsed), ["No layout matched this email."]);
        assert_eq!(parsed_lines(&parsed)[0].spans[0].0, Tone::Danger);
    }

    #[test]
    fn a_layout_that_found_nothing_shows_only_its_name() {
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"matched","layout":{"id":"acme","name":"Acme"},"fields":{},"lineItems":[],"lineItemColumns":[],"attachments":[],"pages":0}"#,
        )
        .unwrap();
        assert_eq!(texts(&parsed), ["Layout: Acme"]);
    }

    #[test]
    fn a_list_summary_says_where_the_rest_is() {
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"matched","layout":{"id":"acme","name":"Acme"},"fields":{"order":"1001"},"lineItems":[],"lineItemColumns":[],"attachments":[],"pages":1,"truncated":true,"partial":true}"#,
        )
        .unwrap();
        assert_eq!(
            texts(&parsed),
            [
                "Layout: Acme",
                "Pages: 1",
                "Cut to fit the email's JSON; the full parse is kept.",
                "Fields",
                "  order: 1001",
                "Lists leave out line items and attachments; get the request for all of it.",
            ]
        );
    }

    #[test]
    fn line_items_follow_line_item_columns_not_key_order() {
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"matched","layout":{"id":"a","name":"A"},"fields":{},"lineItems":[{"zeta":"1","alpha":"2"}],"lineItemColumns":["zeta","alpha"],"attachments":[],"pages":0}"#,
        )
        .unwrap();
        assert_eq!(texts(&parsed)[2..], ["  zeta  alpha", "  1     2"]);

        // Without the columns, every key of every row, sorted.
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"matched","layout":{"id":"a","name":"A"},"fields":{},"lineItems":[{"b":"1"},{"a":"2","c":null}],"lineItemColumns":[],"attachments":[],"pages":0}"#,
        )
        .unwrap();
        assert_eq!(texts(&parsed)[2..], ["  a  b  c", "     1", "  2"]);
    }

    #[test]
    fn wide_tables_and_long_lists_stay_inside_the_terminal() {
        let columns: Vec<String> = (0..30).map(|i| format!("column_{i:02}")).collect();
        let row: serde_json::Map<String, serde_json::Value> = columns
            .iter()
            .map(|column| (column.clone(), "x".repeat(200).into()))
            .collect();
        let parsed: ParsedEmail = serde_json::from_value(serde_json::json!({
            "status": "matched",
            "layout": {"id": "a", "name": "A"},
            "fields": {"note": "y".repeat(500)},
            "lineItems": vec![row; 60],
            "lineItemColumns": columns,
            "attachments": [],
            "pages": 0
        }))
        .unwrap();
        let lines = texts(&parsed);
        for line in &lines {
            assert!(line.width() <= MAX_TABLE_WIDTH + 2, "too wide: {line}");
        }
        assert_eq!(
            lines[2],
            format!("  note: {}...", "y".repeat(MAX_VALUE_WIDTH - 3))
        );
        // 24-column cells and a two-space gap: three columns fit in 92.
        assert_eq!(
            lines[4],
            "  column_00                 column_01                 column_02"
        );
        assert!(lines[5].starts_with(&format!("  {}...  ", "x".repeat(21))));
        assert_eq!(lines.len(), 4 + 1 + MAX_LINE_ITEM_ROWS + 2);
        assert_eq!(lines[lines.len() - 2], "  27 more columns in the JSON.");
        assert_eq!(lines[lines.len() - 1], "  10 more line items in the JSON.");
    }

    #[test]
    fn sender_text_cannot_add_lines_or_escape_codes() {
        let parsed: ParsedEmail = serde_json::from_str(
            r#"{"status":"matched","layout":{"id":"a","name":"A\u001b[2J"},"fields":{"order":"1\n  Layout: fake"},"lineItems":[],"lineItemColumns":[],"attachments":[{"index":4,"filename":null,"format":"text","pages":1,"text":"hi","truncated":true,"error":null}],"pages":1}"#,
        )
        .unwrap();
        assert_eq!(
            texts(&parsed),
            [
                "Layout: A[2J",
                "Pages: 1",
                "Fields",
                "  order: 1   Layout: fake",
                "Attachments",
                "  attachment 5  text, 1 page, 2 B of text, cut off at the limit",
            ]
        );
    }

    #[test]
    fn clip_counts_terminal_columns() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcdef", 5), "ab...");
        // Wide characters take two columns each.
        assert_eq!(clip("注文番号注文番号", 9), "注文番...");
    }
}
