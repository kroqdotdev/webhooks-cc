//! What a failed command reports: a stable error code and exit status that
//! scripts and coding agents can act on, the message, and a next step.
//!
//! Exit statuses (also in `whk --help`):
//!
//! | Status | Code                    | Meaning                                         |
//! | ------ | ----------------------- | ----------------------------------------------- |
//! | 0      |                         | Success                                         |
//! | 1      | `error`, `bad_request`, `delivery_failed`, `billing_refused`, `outcome_unknown` | Any other failure, the server refused input, a test delivery was not accepted, a billing change (approved, or made on the agent budget) was refused with nothing changed (the server's code in `reason`), or it may or may not have been made (check billing) |
//! | 2      | `usage`                 | Bad arguments, or a value the CLI can tell is wrong                |
//! | 3      | `not_logged_in`, `unauthorized`, `connection_revoked`, `login_expired`, `login_denied` | No credentials, or they were refused |
//! | 4      | `not_found`             | No such endpoint, request, team, share, member, invite or approval |
//! | 5      | `forbidden`             | Not allowed: the plan, a limit, or a permission  |
//! | 6      | `rate_limited`          | Too many requests; wait and retry                |
//! | 7      | `server_error`, `network_error`, `request_timeout` | Our side or the network failed; retry |
//! | 8      | `timeout`, `approval_expired`, `quote_changed`, `checkout_expired`, `checkout_superseded` | `whk wait` (or another wait) ran out of time, an approval or checkout link expired, a billing change (approved, or made on the agent budget) was not made because its quote changed, or a checkout's purchase was undone as a duplicate |
//! | 9      | `confirmation_required`, `cancelled`, `approval_denied` | A destructive command was not confirmed, or an approval was refused |

use serde_json::{Value, json};

use crate::agent::AgentError;

/// An API answer with an error status. The message is the server's own
/// words when it gave some.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    /// Seconds from the `Retry-After` header.
    pub retry_after: Option<u64>,
    /// The `code` the answer's body named, when it named one.
    pub code: Option<String>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

/// Failures the CLI decides on itself.
#[derive(Debug, Clone)]
pub enum CliError {
    /// No credentials at all.
    NotLoggedIn(String),
    /// A destructive command without `--yes` and without a terminal to ask on.
    ConfirmationRequired(String),
    /// The person answered no.
    Cancelled,
    /// A wait ran out of time.
    Timeout(String),
    /// The device login's code expired before anyone approved it.
    LoginExpired,
    /// The person refused the device login on its approval page.
    LoginDenied,
    /// The account's owner refused an approval ("This wasn't me").
    ApprovalDenied,
    /// An approval was not answered, or not collected, in time.
    ApprovalExpired,
    /// A checkout link expired before the person paid.
    CheckoutExpired,
    /// A checkout link expired while Polar never said it was unpaid (a
    /// payment still being confirmed a day later, or Polar not answering):
    /// the person may have paid. The same code as CheckoutExpired.
    CheckoutUnsettled,
    /// A checkout link was paid, but the purchase was undone as a duplicate
    /// (the account already had it, or what it added to had ended): its
    /// subscription was ended and a refund is under review.
    CheckoutSuperseded,
    /// Arguments that parse but make no sense together, or a value the
    /// CLI can tell is wrong before asking the server.
    Usage(String),
    /// Nothing by that name or id: a team, share, member or invite the CLI
    /// looked up in a list the server gave it.
    NotFound(String),
    /// A test delivery reached its destination's server (or tried to) and
    /// was not accepted: the destination's fault, so no retry of ours helps.
    DeliveryFailed(String),
    /// An approved billing change was not made: its price or the
    /// subscription moved after it was asked for.
    QuoteChanged(String),
    /// An approved billing change was refused with nothing changed for
    /// another reason (a declined card, too few seats for the members): the
    /// server's code and its words.
    BillingRefused { code: String, reason: String },
    /// An approved billing change may or may not have been made: Polar was
    /// asked, then something failed. Check billing before asking again.
    OutcomeUnknown(String),
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CliError::NotLoggedIn(m)
            | CliError::ConfirmationRequired(m)
            | CliError::Timeout(m)
            | CliError::Usage(m)
            | CliError::NotFound(m)
            | CliError::DeliveryFailed(m)
            | CliError::QuoteChanged(m)
            | CliError::OutcomeUnknown(m) => f.write_str(m),
            CliError::BillingRefused { reason, .. } => f.write_str(reason),
            CliError::Cancelled => f.write_str("Cancelled."),
            CliError::LoginExpired => f.write_str("The login code expired before it was approved."),
            CliError::LoginDenied => f.write_str("The login was refused on its approval page."),
            CliError::ApprovalDenied => {
                f.write_str("The request was refused on its approval page.")
            }
            CliError::ApprovalExpired => {
                f.write_str("The approval expired before it was answered and collected.")
            }
            CliError::CheckoutExpired => {
                f.write_str("The checkout link expired before it was paid.")
            }
            CliError::CheckoutUnsettled => f.write_str(
                "The checkout link expired before Polar confirmed a payment for it. If the person paid, it is still applied to the account once Polar confirms it, and webhooks.cc has been alerted.",
            ),
            CliError::CheckoutSuperseded => f.write_str(
                "By the time this checkout was paid, the account already had what it buys (or what it added to had ended), so the purchase was undone: its subscription was ended and a refund of what it charged is under review. Monthly blocks bought twice stay on the account as one-time blocks instead, and a second overage subscription was ended before it charged anything.",
            ),
        }
    }
}

impl std::error::Error for CliError {}

/// How a failure is reported.
#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    pub code: &'static str,
    pub exit: i32,
    pub status: Option<u16>,
    pub hint: Option<String>,
    pub retry_after: Option<u64>,
    /// The server's own code behind a refusal (`billing_refused`).
    pub reason: Option<String>,
}

impl Classified {
    fn new(code: &'static str, exit: i32) -> Self {
        Self {
            code,
            exit,
            status: None,
            hint: None,
            retry_after: None,
            reason: None,
        }
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

const LOGIN_HINT: &str =
    "Run `whk auth login`, or connect an agent with `whk sandbox connect --email <address>`.";

fn from_status(status: u16, retry_after: Option<u64>) -> Classified {
    let mut c = match status {
        401 => Classified::new("unauthorized", 3).hint(LOGIN_HINT),
        402 | 403 => Classified::new("forbidden", 5),
        404 | 410 => Classified::new("not_found", 4),
        408 => Classified::new("request_timeout", 7).hint("Retry in a little while."),
        429 => Classified::new("rate_limited", 6).hint("Wait, then retry."),
        500..=599 => Classified::new("server_error", 7).hint("Retry in a little while."),
        _ => Classified::new("bad_request", 1),
    };
    c.status = Some(status);
    c.retry_after = retry_after;
    if let (Some(seconds), "rate_limited" | "server_error" | "request_timeout") =
        (retry_after, c.code)
    {
        c.hint = Some(format!("Retry after {seconds} s."));
    }
    c
}

/// The codes the billing routes answer when they refused a change and
/// nothing was changed (lib/billing/change.ts, `BEFORE_POLAR`, less the
/// generic ones a status already says: not found, forbidden, a plan
/// required; and less `quote_changed`, which has a code of its own). A test
/// keeps this list in step with `BEFORE_POLAR`. `payment_action_required` is
/// not here: the bank wants the cardholder to confirm the charge, so the
/// change may still be made, and it reads as `outcome_unknown`.
const BILLING_REFUSALS: &[&str] = &[
    "payment_failed",
    "owner_not_found",
    "seats_below_members",
    "seats_below_minimum",
    "invalid_seats",
    "unchanged",
    "not_scheduled",
    "no_subscription",
    "plan_ending",
    "change_pending",
    "not_offered",
    "past_due",
    "invalid_max",
];

fn is_billing_refusal(code: &str) -> bool {
    BILLING_REFUSALS.contains(&code)
}

fn billing_refused(code: &str, status: Option<u16>) -> Classified {
    if code == "payment_action_required" {
        return payment_action_required(status);
    }
    let hint = format!("Nothing was changed ({code}). Fix what the message says, then ask again.");
    let mut c = Classified::new("billing_refused", 1).hint(hint);
    c.reason = Some(code.to_string());
    c.status = status;
    c
}

/// The bank wants the cardholder to confirm the charge: not a refusal, since
/// the change may still be made once they do, so asking again could repeat
/// it. It reads as `outcome_unknown`, the server's code in `reason`.
fn payment_action_required(status: Option<u16>) -> Classified {
    let mut c = Classified::new("outcome_unknown", 1).hint(
        "The bank wants the cardholder to confirm the payment (Polar emails them a link). Check `whk billing` before asking again.",
    );
    c.reason = Some("payment_action_required".to_string());
    c.status = status;
    c
}

const QUOTE_CHANGED_HINT: &str = "Nothing was changed. Ask again for a new quote.";

const OUTCOME_UNKNOWN_HINT: &str = "The change may have been made. Check `whk billing` (or the team's billing) before asking again.";

/// The code, exit status and next step for a failure, from the first error
/// in its chain that says what went wrong.
pub fn classify(error: &anyhow::Error) -> Classified {
    for cause in error.chain() {
        if let Some(e) = cause.downcast_ref::<CliError>() {
            return match e {
                CliError::NotLoggedIn(_) => {
                    let hint = crate::api::ignored_key_hint().unwrap_or(LOGIN_HINT);
                    Classified::new("not_logged_in", 3).hint(hint)
                }
                CliError::ConfirmationRequired(_) => Classified::new("confirmation_required", 9)
                    .hint("Pass --yes to go ahead without being asked."),
                CliError::Cancelled => Classified::new("cancelled", 9),
                CliError::Timeout(_) => {
                    Classified::new("timeout", 8).hint("Run it again with a longer --timeout.")
                }
                CliError::LoginExpired => {
                    Classified::new("login_expired", 3).hint("Run `whk auth login` again.")
                }
                CliError::ApprovalDenied => Classified::new("approval_denied", 9)
                    .hint("The account's owner refused it. Ask again only if they tell you to."),
                CliError::ApprovalExpired => Classified::new("approval_expired", 8)
                    .hint("Nobody answered it in time. Ask again."),
                CliError::CheckoutExpired => Classified::new("checkout_expired", 8).hint(
                    "Make a new link with `whk billing checkout` if the person still wants it.",
                ),
                CliError::CheckoutUnsettled => Classified::new("checkout_expired", 8).hint(
                    "Check `whk billing` before making a new link: the payment may still land.",
                ),
                CliError::CheckoutSuperseded => Classified::new("checkout_superseded", 8)
                    .hint("Nothing else to do: `whk billing` shows what the account keeps."),
                CliError::LoginDenied => Classified::new("login_denied", 3).hint(
                    "Someone chose \"This wasn't me\". Run `whk auth login` again if it was you.",
                ),
                CliError::Usage(_) => Classified::new("usage", 2),
                CliError::NotFound(_) => Classified::new("not_found", 4),
                CliError::DeliveryFailed(_) => Classified::new("delivery_failed", 1).hint(
                    "Fix the destination (its URL, headers or server), then run the test again.",
                ),
                CliError::QuoteChanged(_) => {
                    Classified::new("quote_changed", 8).hint(QUOTE_CHANGED_HINT)
                }
                CliError::BillingRefused { code, .. } => billing_refused(code, None),
                CliError::OutcomeUnknown(_) => {
                    Classified::new("outcome_unknown", 1).hint(OUTCOME_UNKNOWN_HINT)
                }
            };
        }
        if let Some(e) = cause.downcast_ref::<ApiError>() {
            // A billing change made on the agent budget whose outcome is not
            // known answers with an error status and this code: the same
            // next step as an approved change's.
            if e.code.as_deref() == Some("outcome_unknown") {
                let mut c = Classified::new("outcome_unknown", 1).hint(OUTCOME_UNKNOWN_HINT);
                c.status = Some(e.status);
                return c;
            }
            // The bank wants the cardholder to confirm a charge (a session's
            // change): it may still be made, so not a refusal.
            if e.code.as_deref() == Some("payment_action_required")
                && (400..500).contains(&e.status)
            {
                return payment_action_required(Some(e.status));
            }
            // A billing change not made because its price or the
            // subscription moved: the same code as an approved change's.
            if e.code.as_deref() == Some("quote_changed") && (400..500).contains(&e.status) {
                let mut c = Classified::new("quote_changed", 8).hint(QUOTE_CHANGED_HINT);
                c.status = Some(e.status);
                return c;
            }
            // A billing change refused with nothing changed (a declined
            // card answers 402, which is not the plan forbidding it): the
            // same code as an approved change refused, the server's own in
            // `reason`.
            if let Some(code) = e.code.as_deref().filter(|code| is_billing_refusal(code))
                && (400..500).contains(&e.status)
                && !matches!(e.status, 401 | 404 | 429)
            {
                return billing_refused(code, Some(e.status));
            }
            return from_status(e.status, e.retry_after);
        }
        if let Some(e) = cause.downcast_ref::<AgentError>() {
            // The human disconnected the agent, or its registration ended:
            // the saved connection is gone, which no retry fixes.
            if e.code == "invalid_grant" {
                let mut c = Classified::new("connection_revoked", 3).hint(
                    "The agent connection was revoked or has ended. Connect again with `whk sandbox connect --email <address>`, or run `whk auth login`.",
                );
                c.status = Some(e.status);
                return c;
            }
            return from_status(e.status, e.retry_after);
        }
        if let Some(e) = cause.downcast_ref::<reqwest::Error>() {
            let mut c = Classified::new("network_error", 7);
            if let Some(status) = e.status() {
                return from_status(status.as_u16(), None);
            }
            c = c.hint(if e.is_timeout() {
                "The request timed out. Retry in a little while."
            } else {
                "Could not reach webhooks.cc. Check the network (and WHK_API_URL), then retry."
            });
            return c;
        }
    }
    Classified::new("error", 1)
}

/// Whether a failure is only that whoever read the output stopped reading
/// (`whk usage | head`): not a failure of the command, so it exits quietly.
///
/// A socket that broke while whk was sending (a local server that answers
/// 413 and closes mid-upload) carries the same EPIPE inside an HTTP or
/// WebSocket error: that is a network failure, never a quiet exit.
pub fn is_broken_pipe(error: &anyhow::Error) -> bool {
    let from_network = error.chain().any(|cause| {
        cause.downcast_ref::<reqwest::Error>().is_some()
            || cause
                .downcast_ref::<tokio_tungstenite::tungstenite::Error>()
                .is_some()
    });
    !from_network
        && error.chain().any(|cause| {
            cause
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::BrokenPipe)
        })
}

/// Whether a panic's message is `println!` (or `print!`, `eprintln!`) failing
/// because the pipe it wrote to was closed. Rust ignores SIGPIPE, so a
/// closed pipe comes back as an error, and the print macros panic on it.
pub fn is_broken_pipe_panic(message: &str) -> bool {
    // stdout only: notes on stderr go through errln!, which never panics, so
    // a stderr panic is a bug, never a reason to call a failure a success.
    let printing = message.starts_with("failed printing to stdout");
    // EPIPE's text on Unix; ERROR_BROKEN_PIPE (109) and ERROR_NO_DATA (232)
    // on Windows.
    printing
        && (message.contains("Broken pipe")
            || message.contains("os error 32)")
            || message.contains("os error 109)")
            || message.contains("os error 232)"))
}

/// The JSON a failed command writes to stderr under `--json`.
pub fn error_json(error: &anyhow::Error, c: &Classified) -> Value {
    let mut body = json!({
        "code": c.code,
        "message": format!("{error:#}"),
        "exit": c.exit,
    });
    if let Some(status) = c.status {
        body["status"] = json!(status);
    }
    if let Some(hint) = &c.hint {
        body["hint"] = json!(hint);
    }
    if let Some(seconds) = c.retry_after {
        body["retryAfter"] = json!(seconds);
    }
    if let Some(reason) = &c.reason {
        body["reason"] = json!(reason);
    }
    json!({ "error": body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16) -> anyhow::Error {
        anyhow::Error::new(ApiError {
            status,
            message: "nope".into(),
            retry_after: None,
            code: None,
        })
    }

    #[test]
    fn statuses_map_to_stable_codes_and_exits() {
        let cases = [
            (400, "bad_request", 1),
            (401, "unauthorized", 3),
            (403, "forbidden", 5),
            (404, "not_found", 4),
            (408, "request_timeout", 7),
            (409, "bad_request", 1),
            (429, "rate_limited", 6),
            (503, "server_error", 7),
        ];
        for (status, code, exit) in cases {
            let c = classify(&api(status));
            assert_eq!((c.code, c.exit, c.status), (code, exit, Some(status)));
        }
    }

    #[test]
    fn context_does_not_hide_the_cause() {
        let error = api(404).context("loading the endpoint");
        assert_eq!(classify(&error).code, "not_found");
        let json = error_json(&error, &classify(&error));
        assert_eq!(json["error"]["message"], "loading the endpoint: nope");
        assert_eq!(json["error"]["status"], 404);
        assert_eq!(json["error"]["exit"], 4);
    }

    #[test]
    fn cli_failures_have_their_own_codes() {
        let c = classify(&anyhow::Error::new(CliError::ConfirmationRequired(
            "x".into(),
        )));
        assert_eq!((c.code, c.exit), ("confirmation_required", 9));
        assert!(c.hint.unwrap().contains("--yes"));
        let c = classify(&anyhow::Error::new(CliError::Timeout("x".into())));
        assert_eq!((c.code, c.exit), ("timeout", 8));
        assert_eq!(classify(&anyhow::anyhow!("plain")).code, "error");
        let c = classify(&anyhow::Error::new(CliError::ApprovalDenied));
        assert_eq!((c.code, c.exit), ("approval_denied", 9));
        let c = classify(&anyhow::Error::new(CliError::ApprovalExpired));
        assert_eq!((c.code, c.exit), ("approval_expired", 8));
        let c = classify(&anyhow::Error::new(CliError::LoginDenied));
        assert_eq!((c.code, c.exit), ("login_denied", 3));
        let c = classify(&anyhow::Error::new(CliError::DeliveryFailed("x".into())));
        assert_eq!((c.code, c.exit), ("delivery_failed", 1));
        let error = anyhow::Error::new(CliError::BillingRefused {
            code: "payment_failed".into(),
            reason: "Nothing was changed: the card was declined.".into(),
        });
        let c = classify(&error);
        assert_eq!((c.code, c.exit), ("billing_refused", 1));
        let json = error_json(&error, &c);
        assert_eq!(json["error"]["reason"], "payment_failed");
        assert_eq!(
            json["error"]["message"],
            "Nothing was changed: the card was declined."
        );
        let c = classify(&anyhow::Error::new(CliError::OutcomeUnknown("x".into())));
        assert_eq!((c.code, c.exit), ("outcome_unknown", 1));
        // A billing route's own refusal is billing_refused whatever its
        // status: a declined card's 402 is not the plan forbidding it.
        for (status, code) in [
            (402, "payment_failed"),
            (409, "owner_not_found"),
            (409, "seats_below_members"),
            (409, "unchanged"),
            (400, "not_offered"),
        ] {
            let error = anyhow::Error::new(ApiError {
                status,
                message: "Nothing was changed.".into(),
                retry_after: None,
                code: Some(code.into()),
            });
            let c = classify(&error);
            assert_eq!(
                (c.code, c.exit, c.status),
                ("billing_refused", 1, Some(status))
            );
            assert_eq!(c.reason.as_deref(), Some(code));
            assert_eq!(error_json(&error, &c)["error"]["reason"], code);
        }
        // Without a billing code a 402 is still forbidden, and a 404 or 429
        // keeps its own meaning even with one.
        let c = classify(&anyhow::Error::new(ApiError {
            status: 402,
            message: "Upgrade".into(),
            retry_after: None,
            code: Some("plan_required".into()),
        }));
        assert_eq!((c.code, c.exit), ("forbidden", 5));
        let c = classify(&anyhow::Error::new(ApiError {
            status: 404,
            message: "No subscription".into(),
            retry_after: None,
            code: Some("no_subscription".into()),
        }));
        assert_eq!((c.code, c.exit), ("not_found", 4));
        // A change on the agent budget answers it as an error status.
        let c = classify(&anyhow::Error::new(ApiError {
            status: 502,
            message: "maybe".into(),
            retry_after: None,
            code: Some("outcome_unknown".into()),
        }));
        assert_eq!(
            (c.code, c.exit, c.status),
            ("outcome_unknown", 1, Some(502))
        );
        let c = classify(&anyhow::Error::new(ApiError {
            status: 502,
            message: "down".into(),
            retry_after: None,
            code: Some("something_else".into()),
        }));
        assert_eq!(c.code, "server_error");
    }

    #[test]
    fn a_revoked_agent_connection_says_so() {
        let error = anyhow::Error::new(AgentError::new("invalid_grant", 400, "revoked"));
        let c = classify(&error);
        assert_eq!(
            (c.code, c.exit, c.status),
            ("connection_revoked", 3, Some(400))
        );
        assert!(c.hint.unwrap().contains("sandbox connect"));
    }

    #[test]
    fn a_changed_quote_has_its_own_code() {
        let error = anyhow::Error::new(ApiError {
            status: 409,
            message: "Nothing was changed: the price changed.".into(),
            retry_after: None,
            code: Some("quote_changed".into()),
        });
        let c = classify(&error);
        assert_eq!((c.code, c.exit, c.status), ("quote_changed", 8, Some(409)));
        assert!(c.hint.unwrap().contains("new quote"));
    }

    #[test]
    fn a_confirmation_the_bank_wants_is_no_plain_refusal() {
        let c = classify(&anyhow::Error::new(ApiError {
            status: 402,
            message: "The bank wants the cardholder to confirm this payment.".into(),
            retry_after: None,
            code: Some("payment_action_required".into()),
        }));
        assert_eq!((c.code, c.exit), ("outcome_unknown", 1));
        assert_eq!(c.reason.as_deref(), Some("payment_action_required"));
        let hint = c.hint.unwrap();
        assert!(hint.contains("Check `whk billing`"));
        assert!(!hint.contains("Nothing was changed"));
    }

    /// Every code the web app raises before asking Polar (`BEFORE_POLAR` in
    /// lib/billing/change.ts) is classified here: as a billing refusal, as
    /// `quote_changed`, or as one of the generic codes a status already says.
    #[test]
    fn billing_refusals_follow_the_web_apps_list() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/lib/billing/change.ts");
        let source = std::fs::read_to_string(path).expect("read lib/billing/change.ts");
        let start = source
            .find("const BEFORE_POLAR = {")
            .expect("BEFORE_POLAR in change.ts");
        let block = &source[start..];
        let block = &block[..block.find("\n};").expect("the end of BEFORE_POLAR")];
        let codes: Vec<&str> = block
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|code| !code.is_empty())
            .collect();
        assert!(codes.len() > 10, "read too few codes: {codes:?}");
        // Said by their status (404, 403) or a code of their own.
        const BY_STATUS: &[&str] = &[
            "not_found",
            "user_not_found",
            "team_not_found",
            "forbidden",
            "not_owner",
            "plan_required",
            "quote_changed",
        ];
        let missing: Vec<&str> = codes
            .iter()
            .copied()
            .filter(|code| !BY_STATUS.contains(code) && !is_billing_refusal(code))
            .collect();
        assert!(
            missing.is_empty(),
            "BEFORE_POLAR codes missing from BILLING_REFUSALS: {missing:?}"
        );
    }

    #[test]
    fn a_closed_pipe_is_told_apart() {
        assert!(is_broken_pipe_panic(
            "failed printing to stdout: Broken pipe (os error 32)"
        ));
        assert!(is_broken_pipe_panic(
            "failed printing to stdout: The pipe is being closed. (os error 232)"
        ));
        assert!(!is_broken_pipe_panic(
            "failed printing to stderr: Broken pipe (os error 32)"
        ));
        assert!(!is_broken_pipe_panic(
            "failed printing to stdout: No space left on device (os error 28)"
        ));
        assert!(!is_broken_pipe_panic("Broken pipe somewhere else"));
        let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            .context("writing the export");
        assert!(is_broken_pipe(&error));
        assert!(!is_broken_pipe(&anyhow::anyhow!("nope")));
        // A socket that broke mid-send is a network failure, not a closed stdout.
        let socket = anyhow::Error::new(tokio_tungstenite::tungstenite::Error::Io(
            std::io::Error::from(std::io::ErrorKind::BrokenPipe),
        ))
        .context("sending to the edge");
        assert!(!is_broken_pipe(&socket));
    }

    #[test]
    fn retry_after_becomes_the_hint() {
        let error = anyhow::Error::new(ApiError {
            status: 429,
            message: "slow down".into(),
            retry_after: Some(7),
            code: None,
        });
        let c = classify(&error);
        assert_eq!(c.retry_after, Some(7));
        assert_eq!(c.hint.as_deref(), Some("Retry after 7 s."));
        assert_eq!(error_json(&error, &c)["error"]["retryAfter"], 7);
    }
}
