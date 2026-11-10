//! Werkzeug's debugger (Flask's `--debug`), kept from visitors.
//!
//! The debugger hands its console only to a trusted host, and the edge
//! sends every request as `Host: localhost:<port>` (main.rs), which it
//! trusts. So through a link every visitor would get a Python prompt on
//! the laptop, behind nothing but a PIN they could guess at. The edge
//! refuses what makes the console work, and leaves the traceback page
//! itself alone: it is only HTML.
//!
//! As Werkzeug 3.1 dispatches (`DebuggedApplication.__call__` in
//! `werkzeug/debug/__init__.py`):
//!
//! - Every request the debugger answers itself has `__debugger__=yes` in
//!   its query, with a `cmd`: `resource` (its script, style and icons),
//!   `pinauth` (a PIN guess), `printpin`, or code to run in a frame.
//!   Refused before it reaches the laptop ([`asks_for_debugger`]).
//! - With `use_evalex` on, as `flask run --debug` has it, the path
//!   `/console` is its standalone console page. An app may have a page of
//!   its own there, so that is refused only once the answer shows it is
//!   Werkzeug's ([`may_be_console`], [`is_console_page`]).

use http::{HeaderMap, StatusCode, header};

use crate::header_str;

/// What the CLI prints, once a connection, when a visitor's request for
/// the debugger was refused.
pub const NOTICE: &str = "Not passed to visitors: Werkzeug's debugger (flask run --debug), whose console runs Python on this computer. Its error pages still show to anyone with the link, with your code: share without --debug, or with --password.";

/// The largest answer at `/console` read to see whether it is Werkzeug's
/// console page, which is under 2 KB. A larger one is passed on as it
/// streams, unread.
pub const CONSOLE_PAGE_MAX: u64 = 16 * 1024;

/// Whether a request's query asks for the debugger itself: a parameter
/// `__debugger__` that is `yes`, decoded as Python decodes a query
/// (`parse_qsl`: `+` as a space, then percent-escapes). Werkzeug reads the
/// first such parameter; any is refused here. Pairs are split at `;` as
/// well as `&`, as Python before 3.9.2 split them, so no older setup reads
/// a pair this misses. An app's own query never has this parameter.
pub fn asks_for_debugger(query: Option<&str>) -> bool {
    query.is_some_and(|query| {
        query
            .split(';')
            .flat_map(|part| form_urlencoded::parse(part.as_bytes()))
            .any(|(name, value)| name == "__debugger__" && value == "yes")
    })
}

/// Whether a path is where Werkzeug serves its console, `/console`, as
/// Werkzeug reads a path: percent-decoded by its dev server, then with
/// leading slashes as one (`Request.path`). `/console/` and `/Console` are
/// other pages to it.
pub fn may_be_console(path: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    decoded.trim_start_matches('/') == "console"
}

/// Whether an answer at `/console` is worth reading to tell: a page, short
/// enough, with its length stated, as Werkzeug sends its console page.
pub fn could_be_console_page(status: StatusCode, headers: &HeaderMap) -> bool {
    let html = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html"));
    let short = header_str(headers, "content-length")
        .and_then(|l| l.trim().parse::<u64>().ok())
        .is_some_and(|l| l <= CONSOLE_PAGE_MAX);
    status == StatusCode::OK && html && short
}

/// Whether a page is Werkzeug's console: its title, and the flag its
/// script reads. The traceback page has the same head, with the error as
/// its title and `CONSOLE_MODE = false` (`werkzeug/debug/tbtools.py`).
pub fn is_console_page(body: &[u8]) -> bool {
    contains(body, b"<title>Console // Werkzeug Debugger</title>")
        && contains(body, b"var CONSOLE_MODE = true,")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    /// Werkzeug 3.1.9's console page, as `render_console_html` makes it.
    const CONSOLE: &str = r#"<!doctype html>
<html lang=en>
  <head>
    <title>Console // Werkzeug Debugger</title>
    <link rel="stylesheet" href="?__debugger__=yes&amp;cmd=resource&amp;f=style.css">
    <link rel="shortcut icon"
        href="?__debugger__=yes&amp;cmd=resource&amp;f=console.png">
    <script src="?__debugger__=yes&amp;cmd=resource&amp;f=debugger.js"></script>
    <script>
      var CONSOLE_MODE = true,
          EVALEX = true,
          EVALEX_TRUSTED = false,
          SECRET = "Vg1lnxbB9U8tpd6dLMpN";
    </script>
  </head>
  <body style="background-color: #fff">
    <div class="debugger">
<h1>Interactive Console</h1>
<div class="explanation">
In this console you can execute Python expressions in the context of the
application.  The initial namespace was created by the debugger automatically.
</div>
<div class="console"><div class="inner">The Console requires JavaScript.</div></div>
"#;

    /// The head of its traceback page, for an error.
    const TRACEBACK: &str = r#"<!doctype html>
<html lang=en>
  <head>
    <title>RuntimeError: boom // Werkzeug Debugger</title>
    <link rel="stylesheet" href="?__debugger__=yes&amp;cmd=resource&amp;f=style.css">
    <script>
      var CONSOLE_MODE = false,
          EVALEX = true,
          EVALEX_TRUSTED = false,
          SECRET = "Vg1lnxbB9U8tpd6dLMpN";
    </script>
  </head>
  <body style="background-color: #fff">
    <div class="debugger">
<h1>RuntimeError</h1>
"#;

    #[test]
    fn the_debuggers_own_requests_are_refused() {
        for query in [
            // As the traceback and console pages ask for them.
            "__debugger__=yes&cmd=resource&f=style.css",
            "__debugger__=yes&cmd=resource&f=debugger.js",
            "__debugger__=yes&cmd=pinauth&pin=000-000-000&s=Vg1lnxbB9U8tpd6dLMpN",
            "__debugger__=yes&cmd=printpin&s=Vg1lnxbB9U8tpd6dLMpN",
            "__debugger__=yes&cmd=__import__('os').getcwd()&frm=0&s=Vg1lnxbB9U8tpd6dLMpN",
            // In any order, and with nothing else.
            "cmd=pinauth&pin=1&s=x&__debugger__=yes",
            "__debugger__=yes",
            // Escaped as Python unescapes it.
            "%5F%5Fdebugger%5F%5F=y%65s&cmd=resource&f=style.css",
            "__debugger__=%79%65%73",
            // Split at ; as older Pythons split it, and after another pair.
            "a=1;__debugger__=yes;cmd=pinauth",
            "&&__debugger__=yes",
            "__debugger__=no&__debugger__=yes",
        ] {
            assert!(asks_for_debugger(Some(query)), "{query}");
        }
    }

    #[test]
    fn queries_that_only_look_like_it_go_on() {
        for query in [
            "",
            "q=debugger",
            "debugger=yes",
            "_debugger_=yes",
            "__debugger___=yes",
            "__debugger__=no",
            "__debugger__=YES",
            "__debugger__=yes+",
            "__debugger__=",
            "__debugger__",
            "x=__debugger__=yes",
            "search=__debugger__%3Dyes",
            "cmd=resource&f=style.css",
            "+__debugger__=yes",
        ] {
            assert!(!asks_for_debugger(Some(query)), "{query}");
        }
        assert!(!asks_for_debugger(None));
    }

    #[test]
    fn the_console_path_is_read_as_werkzeug_reads_it() {
        for path in [
            "/console",
            "//console",
            "///console",
            "/%63onsole",
            "/%2Fconsole",
        ] {
            assert!(may_be_console(path), "{path}");
        }
        for path in [
            "/",
            "/console/",
            "/Console",
            "/consoles",
            "/console.js",
            "/admin/console",
            "/console%2F",
            "/__debugger__=yes",
        ] {
            assert!(!may_be_console(path), "{path}");
        }
    }

    fn page_headers(kind: &str, length: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_str(kind).unwrap());
        if let Some(length) = length {
            h.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(length).unwrap(),
            );
        }
        h
    }

    #[test]
    fn only_a_short_page_with_its_length_is_read() {
        let werkzeug = page_headers("text/html; charset=utf-8", Some("1910"));
        assert!(could_be_console_page(StatusCode::OK, &werkzeug));
        assert!(!could_be_console_page(StatusCode::NOT_FOUND, &werkzeug));
        assert!(!could_be_console_page(
            StatusCode::OK,
            &page_headers("text/html", Some("16385"))
        ));
        assert!(!could_be_console_page(
            StatusCode::OK,
            &page_headers("text/html", None)
        ));
        assert!(!could_be_console_page(
            StatusCode::OK,
            &page_headers("application/json", Some("20"))
        ));
    }

    #[test]
    fn werkzeugs_console_page_is_told_from_its_traceback_and_from_an_apps_page() {
        assert!(is_console_page(CONSOLE.as_bytes()));
        // The traceback page is left alone.
        assert!(!is_console_page(TRACEBACK.as_bytes()));
        // An app's own console page.
        assert!(!is_console_page(
            b"<!doctype html><title>Console</title><h1>Game console</h1>"
        ));
        assert!(!is_console_page(b""));
    }
}
