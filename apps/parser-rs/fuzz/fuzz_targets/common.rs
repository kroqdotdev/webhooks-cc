//! Shared set-up for the fuzz targets.

/// libfuzzer-sys aborts on every panic, even one that is caught. The parser
/// catches panics from the libraries it calls by design (they become a
/// `malformed` answer), so only a panic in this crate's own code is a
/// finding: those still abort, the rest are left to unwind into the
/// parser's guard. Set `PARSER_FUZZ_ALL_PANICS=1` to abort on library
/// panics too, to see which inputs reach them.
pub fn abort_on_own_panics() {
    let all = std::env::var_os("PARSER_FUZZ_ALL_PANICS").is_some();
    std::panic::set_hook(Box::new(move |info| {
        let ours = info.location().is_some_and(|l| {
            let file = l.file();
            !file.contains("/.cargo/registry/")
                && !file.contains("/rustc/")
                && !file.starts_with("/cargo/")
        });
        if ours || all {
            eprintln!("panic: {info}");
            std::process::abort();
        }
    }));
}
