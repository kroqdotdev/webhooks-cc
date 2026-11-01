//! webhooks-parser: turns email attachments (CSV, spreadsheets, PDF, plain
//! text) into rows and text for the email-parsing product.
//!
//! Every input comes from whoever sent the email, so each format keeps its
//! own bounds (pages, rows, columns, bytes) and never trusts a size or count
//! the file declares. The binary adds rlimits and a seccomp filter on top;
//! this library is what the binary and the fuzz targets call.

mod cell;
mod decode;
mod delimited;
pub mod fuzzing;
mod ods;
pub mod output;
mod pdf;
#[cfg(target_os = "linux")]
pub mod sandbox;
mod sheet;
#[cfg(test)]
mod testutil;
mod text;
mod xls;
mod xlsx;
mod zipguard;

use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Serialize;

use output::Failure;
pub use output::{ErrorCode, Output, ParseError, Sheet};

/// The page cap when the caller does not set one.
pub const DEFAULT_MAX_PAGES: u64 = 100;
/// The input size cap when the caller does not set one (32 MiB).
pub const DEFAULT_MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Tsv,
    Xlsx,
    Xls,
    Ods,
    Pdf,
    Text,
}

impl std::str::FromStr for Format {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "csv" => Self::Csv,
            "tsv" => Self::Tsv,
            "xlsx" => Self::Xlsx,
            "xls" => Self::Xls,
            "ods" => Self::Ods,
            "pdf" => Self::Pdf,
            "text" => Self::Text,
            _ => return Err(()),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_pages: u64,
    pub max_input_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_pages: DEFAULT_MAX_PAGES,
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
        }
    }
}

/// Parses `input` as `format`. Never panics: a panic inside a parsing
/// library becomes a `malformed` error, because any file that trips one is
/// one we cannot read.
pub fn parse(format: Format, input: &[u8], limits: &Limits) -> Output {
    if input.len() > limits.max_input_bytes {
        return Output::failed(
            format,
            ErrorCode::TooLarge,
            "the file is larger than the limit",
        );
    }
    if input.is_empty() {
        return Output::failed(format, ErrorCode::Empty, "the file is empty");
    }
    guarded(format, || parse_unguarded(format, input, limits))
}

/// Runs `f`, turning a panic into a `malformed` result for `format`. Public
/// only so the binary's self-test can show the path works in the sandbox.
#[doc(hidden)]
pub fn guarded(format: Format, f: impl FnOnce() -> Output) -> Output {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(output) => output,
        Err(_) => Output::failed(format, ErrorCode::Malformed, "the file could not be parsed"),
    }
}

fn parse_unguarded(requested: Format, input: &[u8], limits: &Limits) -> Output {
    let format = match requested {
        Format::Text | Format::Pdf => requested,
        // A spreadsheet saved with the wrong extension, or a text export
        // named .xls, goes to the reader that can actually read it.
        Format::Csv | Format::Tsv => match container(input) {
            Some(format) => format,
            None => requested,
        },
        Format::Xlsx | Format::Xls | Format::Ods => match sniff_spreadsheet(requested, input) {
            Ok(format) => format,
            Err(failure) => return Output::from_failure(requested, failure),
        },
    };
    let max_pages = limits.max_pages;
    let sheets = match format {
        Format::Csv | Format::Tsv => delimited::parse(input, format == Format::Tsv, max_pages),
        Format::Xlsx => xlsx::parse(input, max_pages),
        Format::Xls => xls::parse(input, max_pages),
        Format::Ods => ods::parse(input, max_pages),
        Format::Text => {
            return match text::parse(input) {
                Ok((text, truncated)) => Output {
                    format,
                    pages: 1,
                    truncated,
                    sheets: Vec::new(),
                    text: Some(text),
                    page_texts: None,
                    error: None,
                },
                Err(failure) => Output::from_failure(format, failure),
            };
        }
        Format::Pdf => {
            return match pdf::parse(input, max_pages) {
                Ok(doc) => Output {
                    format,
                    pages: doc.pages.len() as u64,
                    truncated: doc.truncated,
                    sheets: Vec::new(),
                    text: Some(doc.pages.join("\u{c}")),
                    page_texts: Some(doc.pages),
                    error: None,
                },
                Err(failure) => Output::from_failure(format, failure),
            };
        }
    };
    match sheets {
        Ok((sheets, pages, truncated)) => Output::sheets(format, sheets, pages, truncated),
        Err(failure) => Output::from_failure(format, failure),
    }
}

const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// The spreadsheet container the bytes start with, if any.
fn container(input: &[u8]) -> Option<Format> {
    if input.starts_with(b"PK\x03\x04") {
        return Some(match zipguard::kind(input) {
            zipguard::ZipKind::Ods => Format::Ods,
            _ => Format::Xlsx,
        });
    }
    if input.starts_with(&CFB_MAGIC) {
        return Some(Format::Xls);
    }
    None
}

/// Picks the reader for a file the caller called a spreadsheet.
fn sniff_spreadsheet(requested: Format, input: &[u8]) -> Result<Format, Failure> {
    if input.starts_with(b"PK\x03\x04") {
        return Ok(match zipguard::kind(input) {
            zipguard::ZipKind::Ods => Format::Ods,
            zipguard::ZipKind::Xlsx => Format::Xlsx,
            // An archive we cannot place: let the requested reader report it.
            zipguard::ZipKind::Other if requested == Format::Ods => Format::Ods,
            zipguard::ZipKind::Other => Format::Xlsx,
        });
    }
    if input.starts_with(&CFB_MAGIC) {
        return Ok(Format::Xls);
    }
    let head = &input[..input.len().min(8192)];
    let utf16 = decode::is_utf16(head);
    if utf16 || !head.contains(&0) {
        let text = decode::decode_text(head);
        if text.trim_start().starts_with('<') {
            return Err(Failure::new(
                ErrorCode::Unsupported,
                "HTML and XML spreadsheets are not supported",
            ));
        }
        // Many systems export tab- or comma-separated text and call it .xls.
        return Ok(Format::Csv);
    }
    Err(Failure::malformed("the file is not a spreadsheet"))
}
