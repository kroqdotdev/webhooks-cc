//! Runs the built binary the way the web app does: the file on stdin, one
//! JSON object on stdout, the sandbox on.

use std::io::{Cursor, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_webhooks-parser");
/// Anything slower than this is a hang.
const HANG: Duration = Duration::from_secs(120);

struct Run {
    code: Option<i32>,
    stdout: Vec<u8>,
    elapsed: Duration,
}

impl Run {
    fn json(&self) -> Value {
        assert_eq!(self.code, Some(0), "exit status");
        let text = std::str::from_utf8(&self.stdout).expect("utf-8 output");
        assert!(text.ends_with('\n'), "one line of output");
        assert_eq!(
            text.trim_end().lines().count(),
            1,
            "exactly one JSON object"
        );
        serde_json::from_str(text).expect("valid JSON")
    }
}

fn run(args: &[&str], input: &[u8]) -> Run {
    let started = Instant::now();
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the parser");
    let pid = child.id();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    // The parser may stop reading early (input too large); a broken pipe
    // on our side is fine.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = match rx.recv_timeout(HANG) {
        Ok(output) => output.expect("wait for the parser"),
        Err(_) => {
            // SAFETY: killing the child we started.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            panic!("the parser hung on {args:?}");
        }
    };
    let _ = writer.join();
    Run {
        code: output.status.code(),
        stdout: output.stdout,
        elapsed: started.elapsed(),
    }
}

fn parse(format: &str, input: &[u8]) -> Value {
    run(&["--format", format], input).json()
}

fn assert_contract(v: &Value) {
    let keys = [
        "format",
        "pages",
        "truncated",
        "sheets",
        "text",
        "pageTexts",
        "error",
    ];
    let object = v.as_object().expect("an object");
    let mut found: Vec<_> = object.keys().map(String::as_str).collect();
    found.sort_unstable();
    let mut expected = keys.to_vec();
    expected.sort_unstable();
    assert_eq!(found, expected);
    for sheet in v["sheets"].as_array().unwrap() {
        let mut found: Vec<_> = sheet
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        found.sort_unstable();
        assert_eq!(found, ["name", "rowCount", "rows", "truncated"]);
        assert_eq!(
            sheet["rowCount"].as_u64().unwrap(),
            sheet["rows"].as_array().unwrap().len() as u64
        );
        for row in sheet["rows"].as_array().unwrap() {
            assert!(row.as_array().unwrap().iter().all(Value::is_string));
        }
    }
    if let Some(error) = v["error"].as_object() {
        assert!(error["code"].is_string());
        assert!(error["message"].is_string());
        assert_eq!(v["pages"], 0);
    }
}

fn error_code(v: &Value) -> Option<&str> {
    v["error"]["code"].as_str()
}

#[test]
fn csv_follows_the_contract() {
    let v = parse("csv", b"name;amount\nAcme;1,5\n");
    assert_contract(&v);
    assert_eq!(v["format"], "csv");
    assert_eq!(v["pages"], 1);
    assert_eq!(v["truncated"], false);
    assert_eq!(v["text"], Value::Null);
    assert_eq!(v["pageTexts"], Value::Null);
    assert_eq!(v["error"], Value::Null);
    assert_eq!(v["sheets"][0]["name"], Value::Null);
    assert_eq!(
        v["sheets"][0]["rows"],
        serde_json::json!([["name", "amount"], ["Acme", "1,5"]])
    );
}

#[test]
fn text_follows_the_contract() {
    let v = parse(
        "text",
        "BEGIN:VCALENDAR\nSUMMARY:Café\nEND:VCALENDAR\n".as_bytes(),
    );
    assert_contract(&v);
    assert_eq!(v["pages"], 1);
    assert_eq!(v["text"], "BEGIN:VCALENDAR\nSUMMARY:Café\nEND:VCALENDAR\n");
    assert_eq!(v["pageTexts"], Value::Null);
    assert_eq!(v["sheets"], serde_json::json!([]));
}

#[test]
fn long_text_is_truncated_at_one_mib() {
    let v = parse("text", &vec![b'x'; 3 * 1024 * 1024]);
    assert_contract(&v);
    assert_eq!(v["truncated"], true);
    assert_eq!(v["text"].as_str().unwrap().len(), 1024 * 1024);
}

#[test]
fn xlsx_follows_the_contract() {
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("Orders").unwrap();
    ws.write_string(0, 0, "id").unwrap();
    ws.write_number(1, 0, 7).unwrap();
    wb.add_worksheet()
        .set_name("Second")
        .unwrap()
        .write_string(0, 0, "x")
        .unwrap();
    let v = parse("xlsx", &wb.save_to_buffer().unwrap());
    assert_contract(&v);
    assert_eq!(v["pages"], 2);
    assert_eq!(v["sheets"][0]["name"], "Orders");
    assert_eq!(v["sheets"][0]["rows"], serde_json::json!([["id"], ["7"]]));
    assert_eq!(v["sheets"][1]["name"], "Second");
}

#[test]
fn spreadsheets_with_the_wrong_extension_are_sniffed() {
    let mut wb = rust_xlsxwriter::Workbook::new();
    wb.add_worksheet().write_string(0, 0, "real xlsx").unwrap();
    let book = wb.save_to_buffer().unwrap();
    for format in ["xls", "ods", "csv"] {
        let v = parse(format, &book);
        assert_eq!(v["format"], "xlsx", "{format}");
        assert_eq!(v["sheets"][0]["rows"][0][0], "real xlsx");
    }
    // A tab-separated export named .xls.
    let v = parse("xls", b"a\tb\n1\t2\n");
    assert_eq!(v["format"], "csv");
    assert_eq!(v["sheets"][0]["rows"][1], serde_json::json!(["1", "2"]));
    let v = parse("xls", b"<html><table><tr><td>1</td></tr></table></html>");
    assert_eq!(error_code(&v), Some("unsupported"));
}

#[test]
fn ods_through_the_binary() {
    let content = r#"<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Blad1"><table:table-row><table:table-cell office:value-type="float" office:value="3.5"><text:p>3,5</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#;
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("mimetype", stored).unwrap();
    w.write_all(b"application/vnd.oasis.opendocument.spreadsheet")
        .unwrap();
    w.start_file("content.xml", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(content.as_bytes()).unwrap();
    let file = w.finish().unwrap().into_inner();
    let v = parse("ods", &file);
    assert_contract(&v);
    assert_eq!(v["sheets"][0]["name"], "Blad1");
    assert_eq!(v["sheets"][0]["rows"], serde_json::json!([["3.5"]]));
}

fn record(typ: u16, data: &[u8]) -> Vec<u8> {
    let mut r = typ.to_le_bytes().to_vec();
    r.extend_from_slice(&(data.len() as u16).to_le_bytes());
    r.extend_from_slice(data);
    r
}

#[test]
fn xls_through_the_binary() {
    let mut stream = record(0x0809, &[0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0]);
    let at = stream.len() + 4;
    stream.extend(record(0x0085, &[0, 0, 0, 0, 0, 0, 2, 0, b'S', b'1']));
    stream.extend(record(0x000A, &[]));
    let pos = stream.len() as u32;
    stream[at..at + 4].copy_from_slice(&pos.to_le_bytes());
    stream.extend(record(0x0809, &[0x00, 0x06, 0x10, 0x00, 0, 0, 0, 0]));
    let mut number = vec![0, 0, 0, 0, 0, 0];
    number.extend_from_slice(&42.0f64.to_le_bytes());
    stream.extend(record(0x0203, &number));
    stream.extend(record(0x000A, &[]));
    let mut cfb = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    cfb.create_stream("/Workbook")
        .unwrap()
        .write_all(&stream)
        .unwrap();
    cfb.flush().unwrap();
    let file = cfb.into_inner().into_inner();
    let v = parse("xls", &file);
    assert_contract(&v);
    assert_eq!(v["sheets"][0]["name"], "S1");
    assert_eq!(v["sheets"][0]["rows"], serde_json::json!([["42"]]));
}

fn simple_pdf(pages: usize) -> Vec<u8> {
    use lopdf::{Document, Object, Stream, dictionary};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
    );
    let mut kids = Vec::new();
    for i in 1..=pages {
        let content = format!("BT /F1 12 Tf 72 712 Td (Page {i} of {pages}) Tj ET");
        let content = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        kids.push(Object::from(doc.add_object(
            dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => content },
        )));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => pages as i64,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

#[test]
fn pdf_follows_the_contract_and_the_page_cap() {
    let pdf = simple_pdf(3);
    let v = parse("pdf", &pdf);
    assert_contract(&v);
    assert_eq!(v["pages"], 3);
    assert_eq!(v["truncated"], false);
    assert_eq!(
        v["pageTexts"],
        serde_json::json!(["Page 1 of 3", "Page 2 of 3", "Page 3 of 3"])
    );
    assert_eq!(v["text"], "Page 1 of 3\u{c}Page 2 of 3\u{c}Page 3 of 3");
    assert_eq!(v["sheets"], serde_json::json!([]));
    let v = run(&["--format", "pdf", "--max-pages", "2"], &pdf).json();
    assert_eq!(v["pages"], 2);
    assert_eq!(v["truncated"], true);
    assert_eq!(v["pageTexts"].as_array().unwrap().len(), 2);
}

#[test]
fn a_fifty_page_pdf_is_quick() {
    let pdf = simple_pdf(50);
    let r = run(&["--format", "pdf"], &pdf);
    let v = r.json();
    assert_eq!(v["pages"], 50);
    assert!(r.elapsed < Duration::from_secs(20), "{:?}", r.elapsed);
}

#[test]
fn two_million_csv_rows_stop_at_one_hundred_pages() {
    let mut input = Vec::with_capacity(32 * 1024 * 1024);
    for i in 0..2_000_000u32 {
        writeln!(input, "{i},r").unwrap();
    }
    assert!(input.len() <= 32 * 1024 * 1024);
    let r = run(&["--format", "csv"], &input);
    let v = r.json();
    assert_contract(&v);
    assert_eq!(v["pages"], 100);
    assert_eq!(v["truncated"], true);
    assert_eq!(v["sheets"][0]["rowCount"], 100_000);
    assert_eq!(v["sheets"][0]["truncated"], true);
    assert_eq!(
        v["sheets"][0]["rows"][99_999],
        serde_json::json!(["99999", "r"])
    );
    // A debug build; a release build takes well under a second.
    assert!(r.elapsed < Duration::from_secs(60), "{:?}", r.elapsed);
}

#[test]
fn error_codes_for_bad_input() {
    for format in ["csv", "tsv", "xlsx", "xls", "ods", "pdf", "text"] {
        let v = parse(format, b"");
        assert_contract(&v);
        assert_eq!(error_code(&v), Some("empty"), "{format}");
        let v = run(
            &["--format", format, "--max-input-bytes", "10"],
            &[b'a'; 100],
        )
        .json();
        assert_contract(&v);
        assert_eq!(error_code(&v), Some("too_large"), "{format}");
    }
    let v = parse("pdf", b"%PDF-1.7\nthis is not really a pdf");
    assert_eq!(error_code(&v), Some("malformed"));
    let v = parse("xlsx", b"PK\x03\x04 truncated zip");
    assert_eq!(error_code(&v), Some("malformed"));
}

#[test]
fn input_over_the_default_limit_is_too_large() {
    let v = parse("csv", &vec![b'a'; 32 * 1024 * 1024 + 1]);
    assert_eq!(error_code(&v), Some("too_large"));
}

/// A deterministic byte generator (xorshift), so failures reproduce.
fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed.max(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

#[test]
fn random_bytes_never_crash_any_format() {
    let prefixes: [&[u8]; 4] = [
        b"",
        b"PK\x03\x04",
        b"%PDF-1.4\n",
        b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1",
    ];
    for format in ["csv", "tsv", "xlsx", "xls", "ods", "pdf", "text"] {
        for (seed, prefix) in prefixes.iter().enumerate() {
            let mut input = prefix.to_vec();
            input.extend(noise(seed as u64 + 1, 64 * 1024));
            let v = parse(format, &input);
            assert_contract(&v);
        }
    }
}

#[test]
fn truncated_files_never_crash() {
    let mut wb = rust_xlsxwriter::Workbook::new();
    wb.add_worksheet().write_string(0, 0, "x").unwrap();
    let book = wb.save_to_buffer().unwrap();
    let pdf = simple_pdf(2);
    for (format, file) in [("xlsx", &book), ("pdf", &pdf)] {
        for cut in [1, file.len() / 4, file.len() / 2, file.len() - 1] {
            let v = parse(format, &file[..cut]);
            assert_contract(&v);
        }
    }
}

#[test]
fn bad_arguments_exit_2_without_output() {
    for args in [
        &["--format", "docx"][..],
        &[][..],
        &["--format"][..],
        &["--format", "csv", "--max-pages", "x"][..],
    ] {
        let r = run(args, b"a");
        assert_eq!(r.code, Some(2), "{args:?}");
        assert!(r.stdout.is_empty());
    }
}

fn selftest(name: &str, extra: &[&str]) -> Value {
    let mut args = vec!["--selftest", name];
    args.extend_from_slice(extra);
    let r = run(&args, b"");
    assert_eq!(r.code, Some(0), "{name}");
    serde_json::from_slice(&r.stdout).expect("self-test JSON")
}

#[cfg(target_os = "linux")]
#[test]
fn the_sandbox_refuses_network_files_and_processes() {
    for name in ["network", "open", "exec", "fork"] {
        let v = selftest(name, &[]);
        assert_eq!(v["succeeded"], false, "{name}: {v}");
        assert_eq!(v["errno"], libc::EPERM, "{name}: {v}");
    }
    // Without the sandbox the same probe works, so the test can tell.
    let v = selftest("network", &["--no-sandbox"]);
    assert_eq!(v["succeeded"], true, "{v}");
}

#[cfg(target_os = "linux")]
#[test]
fn the_address_space_limit_stops_big_allocations() {
    let v = selftest("alloc", &[]);
    assert_eq!(v["succeeded"], false, "{v}");
}

#[test]
fn a_panic_while_parsing_still_answers_in_json() {
    let r = run(&["--selftest", "panic", "--format", "pdf"], b"");
    let v = r.json();
    assert_contract(&v);
    assert_eq!(v["format"], "pdf");
    assert_eq!(error_code(&v), Some("malformed"));
}

/// When a resource limit fires (here a much smaller address space than the
/// parser sets for itself), the process dies with a signal or a non-zero
/// status and never hangs; the web app treats that as malformed.
#[cfg(target_os = "linux")]
#[test]
fn a_resource_limit_ends_the_process_instead_of_hanging() {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(BIN);
    command.args(["--format", "csv"]);
    // SAFETY: setrlimit is async-signal-safe and touches only the child.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: 48 << 20,
                rlim_max: 48 << 20,
            };
            libc::setrlimit(libc::RLIMIT_AS, &limit);
            Ok(())
        });
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let row = b"x,".repeat(1000);
        for _ in 0..15_000 {
            if stdin.write_all(&row).is_err() || stdin.write_all(b"\n").is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut stdout = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut stdout)
        .unwrap();
    let status = child.wait().unwrap();
    let _ = writer.join();
    assert!(started.elapsed() < HANG);
    if status.success() {
        // It may also fit; then the answer must be a complete JSON object.
        let v: Value = serde_json::from_slice(&stdout).unwrap();
        assert_contract(&v);
    } else {
        assert!(stdout.is_empty() || serde_json::from_slice::<Value>(&stdout).is_err());
    }
}
