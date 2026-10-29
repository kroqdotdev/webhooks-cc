//! Collects rows from every tabular format and applies the billing rules.
//!
//! Billing: each sheet costs one page per started 1,000 rows (1 row is one
//! page, 1,000 rows one page, 1,001 rows two), and a sheet without a single
//! non-empty row costs nothing. Rows are counted after trailing empty rows
//! are dropped, so `pages` is always the sum of `ceil(rowCount / 1000)`.
//!
//! The cap: a sheet gets `remaining_pages * 1000` rows. A sheet with more is
//! cut there and marked truncated, and nothing after it is parsed. A sheet
//! that starts after the budget is used up is left out entirely if it has
//! any content.
//!
//! Formats push rows as they stream them, and the builder answers whether to
//! keep going, so a file with millions of rows stops at the cap instead of
//! being read to the end.

use crate::cell::{MAX_COLUMNS, clip_owned};
use crate::output::Sheet;

pub(crate) const ROWS_PER_PAGE: u64 = 1000;

/// Total bytes of cell text kept across all sheets. A shared string repeated
/// in every cell could otherwise turn a small file into gigabytes of output.
pub(crate) const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

/// A string's length once escaped for JSON: quotes and backslashes take two
/// bytes, control characters up to six. The output budget counts this, so a
/// cell of quotes cannot double the output past it.
pub(crate) fn json_len(s: &str) -> usize {
    s.len()
        + s.bytes()
            .map(|b| match b {
                b'"' | b'\\' => 1,
                0..=0x1f => 5,
                _ => 0,
            })
            .sum::<usize>()
}

/// Total cells kept across all sheets, empty ones inside a row included.
/// Each costs memory and output even when empty, and a row whose only value
/// sits in the last column is a thousand cells. 100,000 rows of 50 columns
/// fit.
pub(crate) const MAX_CELLS: usize = 5_000_000;
/// Sheets listed before the rest are dropped. Empty sheets cost no pages,
/// so without this a workbook could list the same sheet part a million
/// times and have it read a million times.
pub(crate) const MAX_SHEETS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flow {
    Continue,
    /// Stop reading: the budget is used up. Nothing else will be kept.
    Stop,
}

pub(crate) struct SheetsBuilder {
    max_pages: u64,
    pages_used: u64,
    bytes_used: usize,
    cells_used: usize,
    sheets: Vec<Sheet>,
    truncated: bool,
    stopped: bool,
    content_rows: u64,
    current: Option<Current>,
}

struct Current {
    name: Option<String>,
    rows: Vec<Vec<String>>,
    /// Empty rows seen since the last non-empty one. They are only written
    /// out once a later row has content, which drops trailing empty rows
    /// without holding them in memory.
    pending_empty: u64,
    row_limit: u64,
}

impl SheetsBuilder {
    pub(crate) fn new(max_pages: u64) -> Self {
        Self {
            max_pages,
            pages_used: 0,
            bytes_used: 0,
            cells_used: 0,
            sheets: Vec::new(),
            truncated: false,
            stopped: false,
            content_rows: 0,
            current: None,
        }
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// Starts a sheet. Any sheet still open is finished first.
    pub(crate) fn start_sheet(&mut self, name: Option<String>) -> Flow {
        self.finish_sheet();
        if self.stopped {
            return Flow::Stop;
        }
        if self.sheets.len() >= MAX_SHEETS {
            self.give_up();
            return Flow::Stop;
        }
        let remaining = self.max_pages.saturating_sub(self.pages_used);
        self.current = Some(Current {
            name: name.map(clip_owned),
            rows: Vec::new(),
            pending_empty: 0,
            row_limit: remaining.saturating_mul(ROWS_PER_PAGE),
        });
        Flow::Continue
    }

    /// Counts `n` empty rows (gaps between rows, or repeated empty rows).
    pub(crate) fn push_empty_rows(&mut self, n: u64) -> Flow {
        if self.stopped {
            return Flow::Stop;
        }
        if let Some(cur) = self.current.as_mut() {
            cur.pending_empty = cur.pending_empty.saturating_add(n);
        }
        Flow::Continue
    }

    /// Adds one row. Cells past [`MAX_COLUMNS`] and trailing empty cells are
    /// dropped and each cell is clipped, so callers can pass raw values.
    pub(crate) fn push_row(&mut self, mut cells: Vec<String>) -> Flow {
        if self.stopped {
            return Flow::Stop;
        }
        cells.truncate(MAX_COLUMNS);
        while cells.last().is_some_and(|c| c.is_empty()) {
            cells.pop();
        }
        if cells.is_empty() {
            return self.push_empty_rows(1);
        }
        let Some(cur) = self.current.as_mut() else {
            return Flow::Continue;
        };
        let rows_needed = (cur.rows.len() as u64)
            .saturating_add(cur.pending_empty)
            .saturating_add(1);
        if rows_needed > cur.row_limit {
            return self.cut();
        }
        let mut row_bytes = 0usize;
        for cell in cells.iter_mut() {
            let owned = std::mem::take(cell);
            *cell = clip_owned(owned);
            // As written in the JSON output: a cell of quotes doubles there,
            // and each cell adds its quotes and a comma.
            row_bytes += json_len(cell) + 3;
        }
        // The row's brackets and comma.
        row_bytes += 3;
        // Empty rows written out ahead of this one count as a cell each:
        // with a large page cap, a repeated empty row could otherwise ask
        // for billions of them.
        let pending = usize::try_from(cur.pending_empty).unwrap_or(usize::MAX);
        let cost = cells.len().saturating_add(pending);
        if self.bytes_used.saturating_add(row_bytes) > MAX_OUTPUT_BYTES
            || self.cells_used.saturating_add(cost) > MAX_CELLS
        {
            return self.cut();
        }
        self.bytes_used += row_bytes;
        self.cells_used += cost;
        let cur = self.current.as_mut().expect("checked above");
        for _ in 0..cur.pending_empty {
            cur.rows.push(Vec::new());
        }
        cur.pending_empty = 0;
        cur.rows.push(cells);
        self.content_rows += 1;
        Flow::Continue
    }

    /// The current sheet has more rows than the budget allows: keep what we
    /// have, mark it, and stop. A sheet that started with no budget left is
    /// dropped instead, because the caller asked for later sheets to be left
    /// out entirely.
    fn cut(&mut self) -> Flow {
        self.truncated = true;
        self.stopped = true;
        if let Some(cur) = self.current.take()
            && cur.row_limit > 0
        {
            self.close(cur, true);
        }
        Flow::Stop
    }

    fn close(&mut self, cur: Current, truncated: bool) {
        let row_count = cur.rows.len() as u64;
        self.pages_used += row_count.div_ceil(ROWS_PER_PAGE);
        self.sheets.push(Sheet {
            name: cur.name,
            rows: cur.rows,
            row_count,
            truncated,
        });
    }

    pub(crate) fn finish_sheet(&mut self) {
        if let Some(cur) = self.current.take() {
            self.close(cur, false);
        }
    }

    /// Rows the current sheet may hold, empty rows included. Formats that
    /// cannot stream in row order use it to drop cells early.
    pub(crate) fn row_limit(&self) -> u64 {
        self.current.as_ref().map_or(0, |c| c.row_limit)
    }

    /// The current sheet has a value past its row limit: cut it there.
    pub(crate) fn overflow(&mut self) -> Flow {
        if self.stopped {
            return Flow::Stop;
        }
        self.cut()
    }

    /// Stops for a reason outside the row budget (too many sheets, too much
    /// work): what was read is kept and the output is marked truncated.
    pub(crate) fn give_up(&mut self) {
        if self.stopped {
            return;
        }
        self.truncated = true;
        self.stopped = true;
        if let Some(cur) = self.current.take() {
            self.close(cur, true);
        }
    }

    /// Returns the sheets, the pages used and whether anything was cut, or
    /// `None` when no sheet had a single non-empty row.
    pub(crate) fn finish(mut self) -> Option<(Vec<Sheet>, u64, bool)> {
        self.finish_sheet();
        if self.content_rows == 0 && !self.truncated {
            return None;
        }
        Some((self.sheets, self.pages_used, self.truncated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: &str) -> Vec<String> {
        vec![v.to_string()]
    }

    fn fill(b: &mut SheetsBuilder, n: usize) -> Flow {
        for i in 0..n {
            if b.push_row(row(&i.to_string())) == Flow::Stop {
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    fn one_sheet(rows: usize, max_pages: u64) -> (Vec<Sheet>, u64, bool) {
        let mut b = SheetsBuilder::new(max_pages);
        b.start_sheet(None);
        fill(&mut b, rows);
        b.finish().unwrap_or((Vec::new(), 0, false))
    }

    #[test]
    fn pages_are_started_thousands_of_rows() {
        for (rows, pages) in [
            (0, 0),
            (1, 1),
            (999, 1),
            (1000, 1),
            (1001, 2),
            (2000, 2),
            (2001, 3),
        ] {
            let (sheets, used, truncated) = one_sheet(rows, 100);
            assert_eq!(used, pages, "{rows} rows");
            assert!(!truncated);
            if rows > 0 {
                assert_eq!(sheets[0].row_count, rows as u64);
            }
        }
    }

    #[test]
    fn empty_sheets_cost_nothing_and_an_all_empty_book_is_none() {
        let mut b = SheetsBuilder::new(100);
        b.start_sheet(Some("a".into()));
        b.push_row(vec![String::new(), String::new()]);
        b.push_empty_rows(5);
        assert!(b.finish().is_none());
    }

    #[test]
    fn pages_sum_over_sheets() {
        let mut b = SheetsBuilder::new(100);
        b.start_sheet(Some("one".into()));
        fill(&mut b, 1);
        b.start_sheet(Some("empty".into()));
        b.start_sheet(Some("three".into()));
        fill(&mut b, 2500);
        let (sheets, pages, truncated) = b.finish().unwrap();
        // One page, nothing for the empty sheet, three pages.
        assert_eq!(pages, 4);
        assert!(!truncated);
        assert_eq!(sheets.len(), 3);
        assert_eq!(sheets[1].row_count, 0);
    }

    #[test]
    fn a_sheet_crossing_the_cap_keeps_the_remaining_pages_of_rows() {
        let mut b = SheetsBuilder::new(3);
        b.start_sheet(Some("first".into()));
        fill(&mut b, 1500); // 2 pages
        b.start_sheet(Some("second".into()));
        assert_eq!(fill(&mut b, 5000), Flow::Stop);
        assert_eq!(b.start_sheet(Some("third".into())), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert!(truncated);
        assert_eq!(pages, 3);
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[1].row_count, 1000);
        assert!(sheets[1].truncated);
        assert!(!sheets[0].truncated);
    }

    #[test]
    fn exactly_the_cap_is_not_truncated() {
        let (sheets, pages, truncated) = one_sheet(100_000, 100);
        assert_eq!(pages, 100);
        assert!(!truncated);
        assert_eq!(sheets[0].row_count, 100_000);
        let (sheets, pages, truncated) = one_sheet(100_001, 100);
        assert_eq!(pages, 100);
        assert!(truncated);
        assert_eq!(sheets[0].row_count, 100_000);
    }

    #[test]
    fn a_sheet_after_the_budget_is_left_out_unless_empty() {
        let mut b = SheetsBuilder::new(1);
        b.start_sheet(Some("full".into()));
        fill(&mut b, 1000);
        b.start_sheet(Some("empty".into()));
        b.push_empty_rows(3);
        b.start_sheet(Some("more".into()));
        assert_eq!(fill(&mut b, 1), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert!(truncated);
        assert_eq!(pages, 1);
        let names: Vec<_> = sheets.iter().map(|s| s.name.clone().unwrap()).collect();
        assert_eq!(names, ["full", "empty"]);
    }

    #[test]
    fn trailing_empty_rows_and_cells_are_dropped_but_inner_ones_kept() {
        let mut b = SheetsBuilder::new(100);
        b.start_sheet(None);
        b.push_row(vec!["a".into(), String::new(), "b".into(), String::new()]);
        b.push_empty_rows(2);
        b.push_row(row("c"));
        b.push_empty_rows(1_000_000_000);
        let (sheets, pages, _) = b.finish().unwrap();
        assert_eq!(pages, 1);
        assert_eq!(
            sheets[0].rows,
            vec![
                vec!["a".to_string(), String::new(), "b".to_string()],
                vec![],
                vec![],
                vec!["c".to_string()],
            ]
        );
    }

    #[test]
    fn empty_rows_count_towards_the_cap() {
        let mut b = SheetsBuilder::new(1);
        b.start_sheet(None);
        b.push_row(row("a"));
        b.push_empty_rows(5000);
        assert_eq!(b.push_row(row("b")), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert!(truncated);
        assert_eq!(pages, 1);
        assert_eq!(sheets[0].row_count, 1);
    }

    #[test]
    fn columns_are_capped() {
        let mut b = SheetsBuilder::new(1);
        b.start_sheet(None);
        b.push_row(vec!["x".to_string(); MAX_COLUMNS + 10]);
        let (sheets, _, _) = b.finish().unwrap();
        assert_eq!(sheets[0].rows[0].len(), MAX_COLUMNS);
    }

    #[test]
    fn the_output_byte_cap_stops_parsing() {
        let mut b = SheetsBuilder::new(1_000_000);
        b.start_sheet(None);
        let big = "y".repeat(crate::cell::MAX_CELL_BYTES);
        let mut flow = Flow::Continue;
        for _ in 0..10_000 {
            flow = b.push_row(vec![big.clone(); 4]);
            if flow == Flow::Stop {
                break;
            }
        }
        assert_eq!(flow, Flow::Stop);
        let (sheets, _, truncated) = b.finish().unwrap();
        assert!(truncated);
        let total: usize = sheets[0].rows.iter().flatten().map(|c| c.len()).sum();
        assert!(total <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn the_cell_cap_stops_wide_sparse_rows() {
        let mut b = SheetsBuilder::new(100);
        b.start_sheet(None);
        let mut wide = vec![String::new(); MAX_COLUMNS];
        wide[MAX_COLUMNS - 1] = "x".to_string();
        let mut kept = 0;
        while b.push_row(wide.clone()) == Flow::Continue {
            kept += 1;
        }
        assert_eq!(kept, MAX_CELLS / MAX_COLUMNS);
        let (_, _, truncated) = b.finish().unwrap();
        assert!(truncated);
    }

    #[test]
    fn billions_of_empty_rows_before_a_value_are_capped_even_without_a_page_cap() {
        let mut b = SheetsBuilder::new(u64::MAX);
        b.start_sheet(None);
        b.push_empty_rows(4_000_000_000);
        assert_eq!(b.push_row(row("x")), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert!(truncated);
        assert_eq!(pages, 0);
        assert_eq!(sheets[0].row_count, 0);
    }

    #[test]
    fn sheets_past_the_sheet_cap_are_dropped() {
        let mut b = SheetsBuilder::new(100);
        for i in 0..MAX_SHEETS {
            assert_eq!(b.start_sheet(Some(i.to_string())), Flow::Continue);
        }
        assert_eq!(b.start_sheet(Some("one too many".into())), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert_eq!(sheets.len(), MAX_SHEETS);
        assert_eq!(pages, 0);
        assert!(truncated);
    }

    #[test]
    fn zero_pages_allowed_truncates_without_rows() {
        let mut b = SheetsBuilder::new(0);
        b.start_sheet(None);
        assert_eq!(b.push_row(row("a")), Flow::Stop);
        let (sheets, pages, truncated) = b.finish().unwrap();
        assert!(sheets.is_empty());
        assert_eq!(pages, 0);
        assert!(truncated);
    }
}
