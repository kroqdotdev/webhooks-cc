/// `println!` that never panics: a reader that went away (`| head -1`) is
/// ignored, so the command's own result still decides its exit status.
#[macro_export]
macro_rules! outln {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stdout().lock(), $($arg)*);
    }};
}

/// `print!` that never panics, for output without a trailing newline.
#[macro_export]
macro_rules! out {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let mut out = std::io::stdout().lock();
        let _ = write!(out, $($arg)*);
        let _ = out.flush();
    }};
}

/// `println!` that reports a failed write, for output that streams until
/// stopped (`whk listen`): a reader that went away ends the stream.
#[macro_export]
macro_rules! try_outln {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        writeln!(std::io::stdout().lock(), $($arg)*)
    }};
}

/// `eprintln!` that never panics: a progress note on a stderr nobody reads
/// is dropped, so the command's own result still decides its exit status.
#[macro_export]
macro_rules! errln {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr().lock(), $($arg)*);
    }};
}

pub mod agent;
pub mod api;
pub mod auth;
pub mod cli;
pub mod error;
pub mod share;
pub mod tunnel;
pub mod types;
pub mod util;

// Only Unix tests send or handle SIGINT today.
#[cfg(all(test, unix))]
pub(crate) mod test_support;
