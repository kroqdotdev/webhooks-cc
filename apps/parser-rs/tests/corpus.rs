//! Page counts on files written by the libraries real exporters use
//! (tests/corpus/generate.py): each must match the definition of a parsed
//! page, as tests/corpus/manifest.json records it.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_webhooks-parser");

#[test]
fn page_counts_match_the_definition() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let entries = manifest.as_array().unwrap();
    assert!(entries.len() >= 10);
    for entry in entries {
        let file = entry["file"].as_str().unwrap();
        let format = entry["format"].as_str().unwrap();
        let input = std::fs::read(dir.join(file)).unwrap();
        let mut child = Command::new(BIN)
            .args(["--format", format])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{file}: exit {:?}", output.status);
        let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(parsed["error"].is_null(), "{file}: {}", parsed["error"]);
        assert_eq!(
            parsed["pages"], entry["pages"],
            "{file} ({}): pages",
            entry["note"]
        );
    }
}
