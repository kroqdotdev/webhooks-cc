//! A pointer to the repository, shown once per machine after the first
//! tunnel or share someone stops by hand: the moment the tool has just
//! worked for them, and never in the middle of their output.

use std::fs::OpenOptions;
use std::io::IsTerminal;
use std::path::Path;

use crate::cli::output::dim;

pub const REPO_URL: &str = "https://github.com/kroqdotdev/webhooks-cc";

/// The file whose existence means the hint was shown on this machine.
const MARKER: &str = "star-hint-shown";

/// Whether the hint may be shown at all: plain text to a person at a
/// terminal, outside CI, and not turned off with `WHK_NO_STAR_HINT`.
fn allowed(json: bool, stdout_is_terminal: bool, env: impl Fn(&str) -> bool) -> bool {
    !json && stdout_is_terminal && !env("CI") && !env("WHK_NO_STAR_HINT")
}

/// Records the hint as shown, answering true only for the call that made
/// the marker. A config directory that cannot be written means no hint,
/// so it can never repeat on every run.
fn claim(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(MARKER))
        .is_ok()
}

fn text() -> String {
    format!(
        "\n  {} {}\n    {}",
        dim("★"),
        dim("Enjoying whk? A star on GitHub helps other developers find it:"),
        REPO_URL
    )
}

/// The hint the first time it is asked for on this machine, and never
/// again: the caller prints it the way it prints everything else.
pub fn take(json: bool) -> Option<String> {
    let set = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
    if !allowed(json, std::io::stdout().is_terminal(), set) {
        return None;
    }
    let dir = crate::auth::config_dir().ok()?;
    claim(&dir).then(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shown_only_to_a_person_at_a_terminal() {
        let none = |_: &str| false;
        assert!(allowed(false, true, none));
        assert!(
            !allowed(true, true, none),
            "JSON output stays machine-readable"
        );
        assert!(!allowed(false, false, none), "piped output stays clean");
        assert!(!allowed(false, true, |name| name == "CI"));
        assert!(!allowed(false, true, |name| name == "WHK_NO_STAR_HINT"));
    }

    #[test]
    fn claimed_once_per_directory() {
        let dir = std::env::temp_dir().join(format!("whk-star-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(claim(&dir));
        assert!(!claim(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn points_at_the_repository() {
        assert!(text().contains(REPO_URL));
    }
}
