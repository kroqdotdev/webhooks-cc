//! What a failed command reports: a stable error code and exit status that
//! scripts and coding agents can act on, the message, and a next step.
//!
//! Exit statuses (also in `whk --help`):
//!
//! | Status | Code                    | Meaning                                         |
//! | ------ | ----------------------- | ----------------------------------------------- |
//! | 0      |                         | Success                                         |
//! | 1      | `error`, `bad_request`  | Any other failure, or the server refused input   |
//! | 2      | `usage`                 | Bad arguments (clap answers these itself)        |
//! | 3      | `not_logged_in`, `unauthorized`, `connection_revoked` | No credentials, or they were refused |
//! | 4      | `not_found`             | No such endpoint, request, team or share         |
//! | 5      | `forbidden`             | Not allowed: the plan, a limit, or a permission  |
//! | 6      | `rate_limited`          | Too many requests; wait and retry                |
//! | 7      | `server_error`, `network_error`, `request_timeout` | Our side or the network failed; retry |
//! | 8      | `timeout`               | `whk wait` (or another wait) ran out of time     |
//! | 9      | `confirmation_required`, `cancelled` | A destructive command was not confirmed |

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
    /// Arguments that parse but make no sense together.
    Usage(String),
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CliError::NotLoggedIn(m)
            | CliError::ConfirmationRequired(m)
            | CliError::Timeout(m)
            | CliError::Usage(m) => f.write_str(m),
            CliError::Cancelled => f.write_str("Cancelled."),
            CliError::LoginExpired => f.write_str("The login code expired before it was approved."),
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
}

impl Classified {
    fn new(code: &'static str, exit: i32) -> Self {
        Self {
            code,
            exit,
            status: None,
            hint: None,
            retry_after: None,
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
                CliError::Timeout(_) => Classified::new("timeout", 8)
                    .hint("Run it again with a longer --timeout, or check that the sender ran."),
                CliError::LoginExpired => {
                    Classified::new("login_expired", 3).hint("Run `whk auth login` again.")
                }
                CliError::Usage(_) => Classified::new("usage", 2),
            };
        }
        if let Some(e) = cause.downcast_ref::<ApiError>() {
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
    fn retry_after_becomes_the_hint() {
        let error = anyhow::Error::new(ApiError {
            status: 429,
            message: "slow down".into(),
            retry_after: Some(7),
        });
        let c = classify(&error);
        assert_eq!(c.retry_after, Some(7));
        assert_eq!(c.hint.as_deref(), Some("Retry after 7 s."));
        assert_eq!(error_json(&error, &c)["error"]["retryAfter"], 7);
    }
}
