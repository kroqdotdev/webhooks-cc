//! The words the phishing look (inject.rs, badge.js) finds in a page's
//! title: `brands`, names a phishing page pretends to be, and `words`, lure
//! phrases. Either, next to a password or card field, flags the share for
//! staff. The lists live in a file (`EDGE_WORDS_FILE`, JSON `{"brands":
//! [...], "words": [...]}`) rather than in this public code, so the list in
//! production is not something an abuser can read and step around. The
//! repository ships `words.example.json`, which development builds and the
//! tests use when no file is named; a release build refuses to start
//! without one.

use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

const EXAMPLE: &str = include_str!("../words.example.json");

#[derive(Deserialize)]
struct File {
    #[serde(default)]
    brands: Vec<String>,
    #[serde(default)]
    words: Vec<String>,
}

static WORDS: OnceLock<Vec<String>> = OnceLock::new();

/// Every brand and lure word, lowercased, without blanks and repeats.
fn parse(text: &str) -> anyhow::Result<Vec<String>> {
    let file: File = serde_json::from_str(text).map_err(|e| {
        anyhow::anyhow!("EDGE_WORDS_FILE is not {{\"brands\": [...], \"words\": [...]}}: {e}")
    })?;
    let mut all: Vec<String> = file
        .brands
        .into_iter()
        .chain(file.words)
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    all.dedup();
    let mut seen = std::collections::HashSet::new();
    all.retain(|w| seen.insert(w.clone()));
    if all.is_empty() {
        anyhow::bail!("EDGE_WORDS_FILE lists no brands or words");
    }
    Ok(all)
}

/// Loads the lists once, at start: the named file, else (development
/// builds only) the example.
pub fn load(path: Option<&Path>) -> anyhow::Result<usize> {
    let list = match path {
        Some(path) => parse(&std::fs::read_to_string(path).map_err(|e| {
            anyhow::anyhow!("EDGE_WORDS_FILE {} cannot be read: {e}", path.display())
        })?)?,
        None if cfg!(debug_assertions) => parse(EXAMPLE)?,
        None => anyhow::bail!(
            "EDGE_WORDS_FILE is not set: a release build needs the private list of brands and lure words"
        ),
    };
    let count = list.len();
    let _ = WORDS.set(list);
    Ok(count)
}

/// The words in force: those loaded, or the example in development and
/// tests when nothing was.
pub fn all() -> &'static [String] {
    WORDS.get_or_init(|| {
        if cfg!(debug_assertions) {
            parse(EXAMPLE).unwrap_or_default()
        } else {
            Vec::new()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_example_parses_into_one_lowercase_list() {
        let list = parse(EXAMPLE).unwrap();
        assert!(list.contains(&"paypal".to_string()));
        assert!(list.contains(&"seed phrase".to_string()));
        assert!(list.iter().all(|w| *w == w.to_lowercase()));
    }

    #[test]
    fn blanks_and_repeats_go_and_an_empty_list_is_refused() {
        let list = parse(r#"{"brands": [" PayPal ", "paypal", ""], "words": ["Paypal", "lure"]}"#)
            .unwrap();
        assert_eq!(list, vec!["paypal", "lure"]);
        assert!(parse(r#"{"brands": [], "words": []}"#).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn a_missing_file_is_an_error() {
        assert!(load(Some(Path::new("/nonexistent/words.json"))).is_err());
    }
}
