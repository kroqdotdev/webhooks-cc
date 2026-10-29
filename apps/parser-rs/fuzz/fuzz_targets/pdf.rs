//! PDF. The first byte picks the entry point: a whole file, a bare content
//! stream run against a fixed document, or a bare CMap.
#![no_main]

#[path = "common.rs"]
mod common;

use libfuzzer_sys::fuzz_target;
use webhooks_parser::{Format, Limits, fuzzing, parse};

fuzz_target!(init: common::abort_on_own_panics(), |data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode % 3 {
        0 => {
            let limits = Limits {
                max_pages: 3,
                ..Limits::default()
            };
            let _ = parse(Format::Pdf, rest, &limits);
        }
        1 => fuzzing::pdf_content(rest),
        _ => fuzzing::cmap(rest),
    }
});
