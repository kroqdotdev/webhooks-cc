//! SPF, DKIM, DMARC and reverse DNS.
//!
//! The results are recorded for the user to inspect (debugging a sender's
//! authentication is a reason to use the service); they never decide whether
//! mail is accepted. Reverse DNS also decides whether a client counts as a
//! trusted provider for the limits.
//!
//! DKIM verification is CPU work that never yields, so a timeout around it on
//! the async runtime could not fire: one crafted signature (a huge `h=` list
//! over a huge header block) would freeze a worker thread for minutes. The
//! checks therefore run on a blocking thread, and inputs that could only be
//! abuse are not verified at all. A timeout on the caller's side does not stop
//! a blocking task, so the task carries the same deadline for its DNS work and
//! holds one of a fixed number of slots until it has really ended: stalled
//! checks cannot pile up, each holding a message.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::time::Instant;

use mail_auth::dmarc::Policy;
use mail_auth::{
    AuthenticatedMessage, AuthenticationResults, DkimResult, DmarcResult, IprevResult,
    MessageAuthenticator, SpfResult, dmarc::verify::DmarcParameters, spf::verify::SpfParameters,
};
use serde_json::{Value, json};

/// DKIM and DMARC are skipped above these; legitimate mail stays far below.
const MAX_AUTH_HEADER_BYTES: usize = 128 * 1024;
const MAX_DKIM_SIGNATURES: usize = 10;
const MAX_SIGNED_HEADERS: usize = 64;

/// The client's reverse DNS, looked up when the connection opens.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReverseDns {
    /// First PTR name, without the trailing dot.
    pub name: Option<String>,
    /// The PTR name resolves back to the client's address.
    pub confirmed: bool,
}

/// Everything the checks need, owned, so they can run on another thread.
pub struct AuthRequest {
    pub ip: IpAddr,
    pub helo: String,
    /// Envelope sender; empty for bounces.
    pub mail_from: String,
    pub raw: Arc<Vec<u8>>,
    pub reverse_dns: ReverseDns,
}

pub struct AuthOutcome {
    pub json: Value,
}

#[derive(Clone)]
pub struct AuthChecker {
    authenticator: Option<MessageAuthenticator>,
    hostname: Arc<str>,
    budget: Duration,
    /// Checks running on blocking threads, including ones whose caller
    /// already gave up.
    slots: Arc<Semaphore>,
}

impl AuthChecker {
    /// Uses the system's resolver configuration. Without one the checks are
    /// skipped and reported as unavailable.
    pub fn new(hostname: &str, budget: Duration, slots: usize) -> Self {
        let authenticator = match MessageAuthenticator::new_system_conf() {
            Ok(authenticator) => Some(authenticator),
            Err(e) => {
                tracing::warn!(error = %e, "no DNS resolver; authentication checks are off");
                None
            }
        };
        Self {
            authenticator,
            hostname: Arc::from(hostname),
            budget,
            slots: Arc::new(Semaphore::new(slots.max(1))),
        }
    }

    /// A checker that never touches DNS, for tests.
    #[cfg(test)]
    pub fn disabled(hostname: &str) -> Self {
        Self {
            authenticator: None,
            hostname: Arc::from(hostname),
            budget: Duration::from_secs(1),
            slots: Arc::new(Semaphore::new(1)),
        }
    }

    /// Reverse DNS for a new connection, within `budget`. Network work only,
    /// so it runs on the async runtime.
    pub async fn reverse_dns(&self, ip: IpAddr, budget: Duration) -> ReverseDns {
        let Some(authenticator) = &self.authenticator else {
            return ReverseDns::default();
        };
        match tokio::time::timeout(budget, authenticator.verify_iprev(ip)).await {
            Ok(output) => ReverseDns {
                name: output
                    .ptr
                    .as_ref()
                    .and_then(|names| names.first())
                    .map(|name| name.trim_end_matches('.').to_ascii_lowercase()),
                confirmed: matches!(output.result, IprevResult::Pass),
            },
            Err(_) => ReverseDns::default(),
        }
    }

    pub async fn check(&self, request: AuthRequest) -> AuthOutcome {
        let Some(authenticator) = self.authenticator.clone() else {
            return AuthOutcome {
                json: json!({ "error": "unavailable" }),
            };
        };
        let hostname = self.hostname.clone();
        let runtime = tokio::runtime::Handle::current();
        let deadline = Instant::now() + self.budget;
        let json = bounded(&self.slots, deadline, move || {
            runtime.block_on(async {
                tokio::time::timeout_at(deadline, run(&authenticator, &hostname, &request))
                    .await
                    .ok()
            })
        })
        .await;
        AuthOutcome { json }
    }
}

/// Run blocking `work` once one of `slots` is free, answering by `deadline`.
/// The slot stays taken until `work` has returned, even after the caller has
/// stopped waiting, so `work` must honour the deadline itself as far as it
/// can. `None` from `work` means it ran out of time.
async fn bounded<F>(slots: &Arc<Semaphore>, deadline: Instant, work: F) -> Value
where
    F: FnOnce() -> Option<Value> + Send + 'static,
{
    let Ok(Ok(slot)) = tokio::time::timeout_at(deadline, slots.clone().acquire_owned()).await
    else {
        return json!({ "error": "busy" });
    };
    let task = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        work()
    });
    match tokio::time::timeout_at(deadline, task).await {
        Ok(Ok(Some(json))) => json,
        Ok(Ok(None)) | Err(_) => json!({ "error": "timeout" }),
        Ok(Err(_)) => json!({ "error": "failed" }),
    }
}

async fn run(authenticator: &MessageAuthenticator, hostname: &str, request: &AuthRequest) -> Value {
    let helo = request.helo.as_str();
    let mail_from = request.mail_from.as_str();

    // RFC 7208: with an empty MAIL FROM, the HELO identity is checked.
    let spf = if mail_from.is_empty() {
        authenticator
            .verify_spf(SpfParameters::verify_ehlo(request.ip, helo, hostname))
            .await
    } else {
        authenticator
            .verify_spf(SpfParameters::verify_mail_from(
                request.ip, helo, hostname, mail_from,
            ))
            .await
    };
    let mail_from_domain = mail_from
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .unwrap_or(helo);

    let mut json = json!({
        "spf": { "result": spf_result(spf.result()), "domain": spf.domain() },
        "iprev": {
            "result": if request.reverse_dns.confirmed { "pass" } else { "fail" },
            "ptr": request.reverse_dns.name,
        },
    });

    if let Some(reason) = dkim_skip_reason(&request.raw) {
        json["dkim"] = json!([]);
        json["dmarc"] = json!({ "result": "skipped", "reason": reason });
        return json;
    }
    let Some(message) = AuthenticatedMessage::parse(&request.raw) else {
        json["dkim"] = json!([]);
        json["dmarc"] = json!({ "result": "none" });
        return json;
    };
    let dkim = authenticator.verify_dkim(&message).await;
    let dmarc = authenticator
        .verify_dmarc(DmarcParameters::new(
            &message,
            &dkim,
            mail_from_domain,
            &spf,
        ))
        .await;

    json["dkim"] = Value::Array(
        dkim.iter()
            .map(|output| {
                let signature = output.signature();
                json!({
                    "result": dkim_result(output.result()),
                    "domain": signature.map(|s| s.d.clone()),
                    "selector": signature.map(|s| s.s.clone()),
                })
            })
            .collect(),
    );
    let aligned = |r: &DmarcResult| matches!(r, DmarcResult::Pass);
    let overall = if aligned(dmarc.spf_result()) || aligned(dmarc.dkim_result()) {
        "pass"
    } else if matches!(dmarc.dkim_result(), DmarcResult::None)
        && matches!(dmarc.spf_result(), DmarcResult::None)
    {
        "none"
    } else if matches!(dmarc.dkim_result(), DmarcResult::TempError(_))
        || matches!(dmarc.spf_result(), DmarcResult::TempError(_))
    {
        "temperror"
    } else {
        "fail"
    };
    json["dmarc"] = json!({
        "result": overall,
        "domain": dmarc.domain(),
        "policy": policy(dmarc.policy()),
        "spf": dmarc_result(dmarc.spf_result()),
        "dkim": dmarc_result(dmarc.dkim_result()),
    });

    let results = AuthenticationResults::new(hostname)
        .with_dkim_results(&dkim, message.from())
        .with_spf_mailfrom_result(&spf, request.ip, mail_from, helo)
        .with_dmarc_result(&dmarc);
    json["authentication_results"] = Value::String(results.to_string());
    json
}

/// Index just past the blank line that ends the header section.
pub fn header_section_end(raw: &[u8]) -> Option<usize> {
    let crlf = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
    let lf = raw.windows(2).position(|w| w == b"\n\n").map(|i| i + 2);
    match (crlf, lf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Why DKIM and DMARC must not run on this message, if they must not.
fn dkim_skip_reason(raw: &[u8]) -> Option<&'static str> {
    let end = header_section_end(raw).unwrap_or(raw.len());
    if end > MAX_AUTH_HEADER_BYTES {
        return Some("header section too large");
    }
    let headers = String::from_utf8_lossy(&raw[..end]);
    // Unfold: a line starting with whitespace continues the previous field.
    let mut fields: Vec<String> = Vec::new();
    for line in headers.split('\n') {
        let line = line.trim_end_matches('\r');
        match (line.starts_with([' ', '\t']), fields.last_mut()) {
            (true, Some(last)) => last.push_str(line),
            _ => fields.push(line.to_string()),
        }
    }
    let mut signatures = 0;
    for field in &fields {
        let Some((name, value)) = field.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("dkim-signature") {
            continue;
        }
        signatures += 1;
        if signatures > MAX_DKIM_SIGNATURES {
            return Some("too many DKIM signatures");
        }
        for tag in value.split(';') {
            if let Some((tag_name, list)) = tag.split_once('=')
                && tag_name.trim().eq_ignore_ascii_case("h")
                && list.split(':').count() > MAX_SIGNED_HEADERS
            {
                return Some("too many signed headers");
            }
        }
    }
    None
}

fn spf_result(result: SpfResult) -> &'static str {
    match result {
        SpfResult::Pass => "pass",
        SpfResult::Fail => "fail",
        SpfResult::SoftFail => "softfail",
        SpfResult::Neutral => "neutral",
        SpfResult::TempError => "temperror",
        SpfResult::PermError => "permerror",
        SpfResult::None => "none",
    }
}

fn dkim_result(result: &DkimResult) -> &'static str {
    match result {
        DkimResult::Pass => "pass",
        DkimResult::Neutral(_) => "neutral",
        DkimResult::Fail(_) => "fail",
        DkimResult::PermError(_) => "permerror",
        DkimResult::TempError(_) => "temperror",
        DkimResult::None => "none",
    }
}

fn dmarc_result(result: &DmarcResult) -> &'static str {
    match result {
        DmarcResult::Pass => "pass",
        DmarcResult::Fail(_) => "fail",
        DmarcResult::TempError(_) => "temperror",
        DmarcResult::PermError(_) => "permerror",
        DmarcResult::None => "none",
    }
}

fn policy(policy: Policy) -> &'static str {
    match policy {
        Policy::None => "none",
        Policy::Quarantine => "quarantine",
        Policy::Reject => "reject",
        Policy::Unspecified => "unspecified",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(raw: &[u8]) -> AuthRequest {
        AuthRequest {
            ip: "192.0.2.1".parse().unwrap(),
            helo: "mail.example.com".into(),
            mail_from: "a@example.com".into(),
            raw: Arc::new(raw.to_vec()),
            reverse_dns: ReverseDns::default(),
        }
    }

    #[tokio::test]
    async fn reports_unavailable_without_a_resolver() {
        let checker = AuthChecker::disabled("mx.example");
        let outcome = checker.check(request(b"Subject: x\r\n\r\nbody\r\n")).await;
        assert_eq!(outcome.json, json!({"error": "unavailable"}));
        assert_eq!(
            checker
                .reverse_dns("192.0.2.1".parse().unwrap(), Duration::from_secs(1))
                .await,
            ReverseDns::default()
        );
    }

    #[tokio::test]
    async fn a_check_that_overruns_keeps_its_slot_until_it_really_ends() {
        let slots = Arc::new(Semaphore::new(1));
        let budget = Duration::from_millis(100);
        let slow = bounded(&slots, Instant::now() + budget, || {
            std::thread::sleep(Duration::from_millis(400));
            Some(json!({ "late": true }))
        })
        .await;
        assert_eq!(slow, json!({ "error": "timeout" }));
        // The slow task is still running and still holds the only slot.
        let blocked = bounded(&slots, Instant::now() + budget, || Some(json!({}))).await;
        assert_eq!(blocked, json!({ "error": "busy" }));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let next = bounded(&slots, Instant::now() + budget, || Some(json!({ "ok": 1 }))).await;
        assert_eq!(next, json!({ "ok": 1 }));
        let gave_up = bounded(&slots, Instant::now() + budget, || None).await;
        assert_eq!(gave_up, json!({ "error": "timeout" }));
    }

    #[test]
    fn names_results_in_lowercase() {
        assert_eq!(spf_result(SpfResult::SoftFail), "softfail");
        assert_eq!(dkim_result(&DkimResult::None), "none");
        assert_eq!(dmarc_result(&DmarcResult::Pass), "pass");
        assert_eq!(policy(Policy::Reject), "reject");
    }

    #[test]
    fn verifies_ordinary_signed_mail() {
        let raw = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=s1;\r\n\th=from:to:subject:date; bh=abc; b=def\r\nFrom: a@example.com\r\n\r\nbody\r\n";
        assert_eq!(dkim_skip_reason(raw.as_bytes()), None);
    }

    #[test]
    fn skips_dkim_for_abusive_input() {
        let many_h = (0..MAX_SIGNED_HEADERS + 1)
            .map(|i| format!("x{i}"))
            .collect::<Vec<_>>()
            .join(":");
        let raw = format!(
            "DKIM-Signature: v=1; d=example.com; s=s1;\r\n h={many_h}; b=x\r\n\r\nbody\r\n"
        );
        assert_eq!(
            dkim_skip_reason(raw.as_bytes()),
            Some("too many signed headers")
        );

        let raw =
            "DKIM-Signature: v=1; h=from; b=x\r\n".repeat(MAX_DKIM_SIGNATURES + 1) + "\r\nbody\r\n";
        assert_eq!(
            dkim_skip_reason(raw.as_bytes()),
            Some("too many DKIM signatures")
        );

        let raw = format!(
            "X-Pad: {}\r\n\r\nbody\r\n",
            "p".repeat(MAX_AUTH_HEADER_BYTES)
        );
        assert_eq!(
            dkim_skip_reason(raw.as_bytes()),
            Some("header section too large")
        );
    }

    #[test]
    fn finds_the_end_of_the_header_section() {
        assert_eq!(header_section_end(b"A: b\r\n\r\nbody"), Some(8));
        assert_eq!(header_section_end(b"A: b\n\nbody"), Some(6));
        assert_eq!(header_section_end(b"A: b\r\n"), None);
    }
}
