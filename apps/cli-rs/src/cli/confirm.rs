//! Asking before a destructive command, in a way that never blocks a script
//! or an agent: without a terminal there is no one to ask, so the command
//! fails with `confirmation_required` (exit 9) and says to pass `--yes`.

use std::io::{self, BufRead, IsTerminal, Write};

use anyhow::Result;

use crate::error::CliError;

/// Goes ahead when `yes`, else asks `question` on the terminal. Fails with
/// [`CliError::ConfirmationRequired`] when stdin or stderr is not a terminal,
/// and with [`CliError::Cancelled`] when the answer is not "y".
pub fn confirm(question: &str, yes: bool) -> Result<()> {
    if yes {
        return Ok(());
    }
    let interactive = io::stdin().is_terminal() && io::stderr().is_terminal();
    decide(question, interactive, || {
        // The question goes to stderr, so stdout stays clean for --json.
        eprint!("  {question} [y/N] ");
        io::stderr().flush()?;
        let mut input = String::new();
        io::stdin().lock().read_line(&mut input)?;
        Ok(input)
    })
}

pub(crate) fn decide(
    question: &str,
    interactive: bool,
    ask: impl FnOnce() -> io::Result<String>,
) -> Result<()> {
    if !interactive {
        return Err(CliError::ConfirmationRequired(format!(
            "{question} Not asked, because no terminal is attached: pass --yes to go ahead."
        ))
        .into());
    }
    let answer = ask()?;
    if answer.trim().eq_ignore_ascii_case("y") || answer.trim().eq_ignore_ascii_case("yes") {
        Ok(())
    } else {
        Err(CliError::Cancelled.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::classify;

    #[test]
    fn without_a_terminal_it_refuses_instead_of_waiting() {
        let error = decide("Delete endpoint acme?", false, || {
            panic!("must not read stdin without a terminal")
        })
        .unwrap_err();
        let c = classify(&error);
        assert_eq!((c.code, c.exit), ("confirmation_required", 9));
        assert!(error.to_string().contains("--yes"));
    }

    #[test]
    fn only_yes_goes_ahead() {
        assert!(decide("Go?", true, || Ok("y\n".into())).is_ok());
        assert!(decide("Go?", true, || Ok("YES\n".into())).is_ok());
        let error = decide("Go?", true, || Ok("\n".into())).unwrap_err();
        assert_eq!(classify(&error).code, "cancelled");
    }

    #[test]
    fn yes_skips_the_question() {
        assert!(confirm("Go?", true).is_ok());
    }
}
