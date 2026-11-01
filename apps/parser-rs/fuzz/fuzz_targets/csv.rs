//! Delimited and plain text: CSV with delimiter detection, TSV, and text.
#![no_main]

#[path = "common.rs"]
mod common;

use libfuzzer_sys::fuzz_target;
use webhooks_parser::{Format, Limits, parse};

fuzz_target!(init: common::abort_on_own_panics(), |data: &[u8]| {
    let limits = Limits {
        max_pages: 3,
        ..Limits::default()
    };
    for format in [Format::Csv, Format::Tsv, Format::Text] {
        let _ = parse(format, data, &limits);
    }
});
