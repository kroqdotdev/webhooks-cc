//! webhooks-parser: reads one attachment on stdin and prints one JSON
//! object describing its rows or text.
//!
//! Exit status: 0 whenever the JSON was written, including for files that
//! could not be parsed (the error is in the JSON). 2 for bad arguments, 3
//! when the sandbox could not be set up (we fail closed), 1 when stdout
//! could not be written. A signal means a resource limit fired; the caller
//! treats that, like any non-zero exit, as a malformed file.

use std::io::{self, Read, Write};
use std::process::exit;

use webhooks_parser::{
    DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_PAGES, ErrorCode, Format, Limits, Output,
};

/// Writes a line to stderr. Unlike `eprintln!`, a failed write is ignored
/// rather than turned into a panic, which inside the panic hook would abort.
macro_rules! complain {
    ($($arg:tt)*) => {{
        let _ = writeln!(io::stderr(), "webhooks-parser: {}", format_args!($($arg)*));
    }};
}

const USAGE: &str = "usage: webhooks-parser --format <csv|tsv|xlsx|xls|ods|pdf|text> \
[--max-pages N] [--max-input-bytes N] [--no-sandbox]";

struct Args {
    format: Format,
    limits: Limits,
    sandbox: bool,
    selftest: Option<SelfTest>,
}

/// Probes used by the integration tests to check that the sandbox and the
/// limits hold. Hidden from the usage text.
#[derive(Clone, Copy)]
enum SelfTest {
    Network,
    Open,
    Alloc,
    Exec,
    Fork,
    /// A panic inside the parse guard, which must still come back as JSON.
    Panic,
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut format = None;
    let mut limits = Limits {
        max_pages: DEFAULT_MAX_PAGES,
        max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
    };
    let mut sandbox = true;
    let mut selftest = None;
    let mut args = args;
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--format" => {
                let v = value("--format")?;
                format = Some(
                    v.parse::<Format>()
                        .map_err(|()| format!("unknown format {v:?}"))?,
                );
            }
            "--max-pages" => {
                limits.max_pages = value("--max-pages")?
                    .parse()
                    .map_err(|_| "--max-pages must be a whole number".to_string())?;
            }
            "--max-input-bytes" => {
                limits.max_input_bytes = value("--max-input-bytes")?
                    .parse()
                    .map_err(|_| "--max-input-bytes must be a whole number".to_string())?;
            }
            "--no-sandbox" => sandbox = false,
            "--selftest" => {
                selftest = Some(match value("--selftest")?.as_str() {
                    "network" => SelfTest::Network,
                    "open" => SelfTest::Open,
                    "alloc" => SelfTest::Alloc,
                    "exec" => SelfTest::Exec,
                    "fork" => SelfTest::Fork,
                    "panic" => SelfTest::Panic,
                    other => return Err(format!("unknown self-test {other:?}")),
                });
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let format = match (format, selftest) {
        (Some(f), _) => f,
        (None, Some(_)) => Format::Text,
        (None, None) => return Err("--format is required".to_string()),
    };
    Ok(Args {
        format,
        limits,
        sandbox,
        selftest,
    })
}

fn main() {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            complain!("{message}\n{USAGE}");
            exit(2);
        }
    };

    // The default hook prints the panic message, which a parsing library
    // may have built from the file's bytes, and may open files to print a
    // backtrace. Report only where it happened.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        complain!("a parser panicked at {location}");
    }));

    if args.sandbox {
        set_limits();
    }

    let mut input = Vec::new();
    let read = io::stdin()
        .lock()
        .take((args.limits.max_input_bytes as u64).saturating_add(1))
        .read_to_end(&mut input);
    if let Err(e) = read {
        complain!("could not read stdin: {e}");
        exit(1);
    }

    if args.sandbox {
        install_filter();
    }

    match args.selftest {
        Some(SelfTest::Panic) => {
            write_output(&webhooks_parser::guarded(args.format, || {
                panic!("self-test")
            }));
            return;
        }
        Some(test) => {
            print_line(&run_selftest(test));
            return;
        }
        None => {}
    }

    let output = if input.len() > args.limits.max_input_bytes {
        Output::failed(
            args.format,
            ErrorCode::TooLarge,
            "the file is larger than the limit",
        )
    } else {
        webhooks_parser::parse(args.format, &input, &args.limits)
    };
    drop(input);
    write_output(&output);
}

#[cfg(target_os = "linux")]
fn set_limits() {
    if let Err(e) = webhooks_parser::sandbox::set_rlimits() {
        complain!("could not set resource limits: {e}");
        exit(3);
    }
}

#[cfg(target_os = "linux")]
fn install_filter() {
    if let Err(e) = webhooks_parser::sandbox::install_seccomp() {
        complain!("{e}");
        exit(3);
    }
}

// Elsewhere there is no sandbox to set up, and running without one must be
// asked for explicitly.
#[cfg(not(target_os = "linux"))]
fn set_limits() {
    complain!("the sandbox needs Linux; pass --no-sandbox to run without it");
    exit(3);
}

#[cfg(not(target_os = "linux"))]
fn install_filter() {}

fn write_output(output: &Output) {
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let written = serde_json::to_writer(&mut out, output)
        .map_err(io::Error::from)
        .and_then(|()| out.write_all(b"\n"))
        .and_then(|()| out.flush());
    if let Err(e) = written {
        complain!("could not write the result: {e}");
        exit(1);
    }
}

fn print_line(value: &serde_json::Value) {
    write_line(&value.to_string());
}

fn write_line(line: &str) {
    let mut out = io::stdout().lock();
    if writeln!(out, "{line}").and_then(|()| out.flush()).is_err() {
        exit(1);
    }
}

fn errno_of(result: io::Result<()>) -> serde_json::Value {
    match result {
        Ok(()) => serde_json::Value::Null,
        Err(e) => e.raw_os_error().map_or(serde_json::Value::Null, Into::into),
    }
}

/// Tries something the sandbox or the limits must stop and reports what
/// happened as `{"selftest", "succeeded", "errno"}`.
fn run_selftest(test: SelfTest) -> serde_json::Value {
    let (name, result): (&str, io::Result<()>) = match test {
        SelfTest::Network => ("network", selftest_socket()),
        SelfTest::Open => ("open", std::fs::File::open("/etc/hostname").map(drop)),
        SelfTest::Alloc => {
            // More than the address-space limit allows. try_reserve reports
            // the failure instead of aborting, and touching every page
            // makes sure an optimistic kernel really had to provide it.
            let mut v: Vec<u8> = Vec::new();
            let result = match v.try_reserve_exact(2 << 30) {
                Ok(()) => {
                    v.resize(2 << 30, 1);
                    Ok(())
                }
                Err(_) => Err(io::Error::from_raw_os_error(libc_enomem())),
            };
            ("alloc", result)
        }
        SelfTest::Exec => (
            "exec",
            std::process::Command::new("/bin/true").status().map(drop),
        ),
        SelfTest::Fork => ("fork", selftest_fork()),
        SelfTest::Panic => unreachable!("main handles the panic self-test"),
    };
    serde_json::json!({
        "selftest": name,
        "succeeded": result.is_ok(),
        "errno": errno_of(result),
    })
}

#[cfg(unix)]
fn libc_enomem() -> i32 {
    libc::ENOMEM
}

#[cfg(not(unix))]
fn libc_enomem() -> i32 {
    12
}

#[cfg(unix)]
fn selftest_socket() -> io::Result<()> {
    // SAFETY: socket() takes plain integers; a valid descriptor is closed.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a descriptor we own.
    unsafe { libc::close(fd) };
    Ok(())
}

#[cfg(not(unix))]
fn selftest_socket() -> io::Result<()> {
    std::net::TcpStream::connect("127.0.0.1:9").map(drop)
}

#[cfg(unix)]
fn selftest_fork() -> io::Result<()> {
    // SAFETY: the child exits at once without touching shared state.
    match unsafe { libc::fork() } {
        -1 => Err(io::Error::last_os_error()),
        0 => unsafe { libc::_exit(0) },
        pid => {
            let mut status = 0;
            // SAFETY: waiting for the child we just started.
            unsafe { libc::waitpid(pid, &mut status, 0) };
            Ok(())
        }
    }
}

#[cfg(not(unix))]
fn selftest_fork() -> io::Result<()> {
    Ok(())
}
