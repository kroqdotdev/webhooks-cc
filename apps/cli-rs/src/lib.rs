/// `println!` that ignores a reader that went away (`| head -1`), so the
/// command's own result still decides its exit status. Any other failed
/// write (a full disk, an I/O error) still fails as `println!` does: a
/// cut-short file must never read as success.
#[macro_export]
macro_rules! outln {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        $crate::stdout_written(writeln!(std::io::stdout().lock(), $($arg)*));
    }};
}

/// `print!` with the same rule as `outln!`, for output without a trailing
/// newline.
#[macro_export]
macro_rules! out {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let mut out = std::io::stdout().lock();
        $crate::stdout_written(write!(out, $($arg)*).and_then(|()| out.flush()));
    }};
}

/// The result of a write to stdout from `outln!` or `out!`: a closed pipe
/// is ignored, anything else panics with `println!`'s own message, which
/// the panic handler reports as a failure (only a broken pipe reads as 0).
#[doc(hidden)]
pub fn stdout_written(result: std::io::Result<()>) {
    if let Err(error) = result
        && error.kind() != std::io::ErrorKind::BrokenPipe
    {
        panic!("failed printing to stdout: {error}");
    }
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

#[cfg(test)]
mod stdout_tests {
    use super::stdout_written;
    use std::io::{Error, ErrorKind};

    #[test]
    fn a_closed_pipe_is_ignored() {
        stdout_written(Err(Error::from(ErrorKind::BrokenPipe)));
        stdout_written(Ok(()));
    }

    #[test]
    #[should_panic(expected = "failed printing to stdout")]
    fn any_other_failed_write_fails() {
        stdout_written(Err(Error::from(ErrorKind::StorageFull)));
    }
}
