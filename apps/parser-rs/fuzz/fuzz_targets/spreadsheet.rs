//! Spreadsheets. The first byte picks the entry point: whole files (sniffed
//! to XLSX, ODS, XLS or CSV), a bare XLS workbook stream, a bare ODS
//! content.xml, or a bare XLSX worksheet.
#![no_main]

#[path = "common.rs"]
mod common;

use libfuzzer_sys::fuzz_target;
use webhooks_parser::{Format, Limits, fuzzing, parse};

fuzz_target!(init: common::abort_on_own_panics(), |data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode % 4 {
        0 => {
            let limits = Limits {
                max_pages: 3,
                ..Limits::default()
            };
            let _ = parse(Format::Xlsx, rest, &limits);
        }
        1 => fuzzing::xls_stream(rest),
        2 => fuzzing::ods_content(rest),
        _ => fuzzing::xlsx_sheet(rest),
    }
});
