//! SPF, DKIM, DMARC, ARC and reverse DNS, and what the sender's DNS says
//! about its setup (`sender_setup`).
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
//!
//! A lookup that could not finish (a timeout, SERVFAIL) is RFC 8601's
//! `temperror`, never a `fail`: a sender with a valid PTR record must not be
//! told its reverse DNS is missing because our resolver was slow. DNS
//! queries are sent again after `DNS_ATTEMPT_TIMEOUT`, and the resolver's
//! cache is shared by every session, so a sender's records are looked up
//! once per TTL rather than once per message.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::time::Instant;

use mail_auth::common::cache::NoCache;
use mail_auth::dmarc::Policy;
use mail_auth::hickory_resolver::config::{NameServerConfig, ResolverConfig, ResolverOpts};
use mail_auth::hickory_resolver::system_conf::read_system_conf;
use mail_auth::{
    AuthenticatedMessage, AuthenticationResults, DkimResult, DmarcResult, DnsError,
    MessageAuthenticator, RecordSet, SpfResult, dmarc::verify::DmarcParameters,
    spf::verify::SpfParameters,
};
use serde_json::{Value, json};

use crate::sender_setup::{LiveDns, SetupInput, sender_setup};

/// DKIM and DMARC are skipped above these; legitimate mail stays far below.
const MAX_AUTH_HEADER_BYTES: usize = 128 * 1024;
const MAX_DKIM_SIGNATURES: usize = 10;
const MAX_SIGNED_HEADERS: usize = 64;
/// ARC is skipped above this many seals or message signatures. Each hop
/// that forwards a message adds one set; real chains have a few.
const MAX_ARC_SETS: usize = 10;
/// The receiver keeps no auth document over 16 KiB at all; past this the
/// sender-setup facts and the ARC details go first.
const MAX_AUTH_JSON_BYTES: usize = 14 * 1024;
/// Longest domain name kept from a header.
const MAX_DOMAIN_CHARS: usize = 253;
/// What the sender-setup lookups leave for the deadline, so the results
/// already in hand are kept when they run long.
const SETUP_MARGIN: Duration = Duration::from_millis(250);

/// How long one DNS query waits for its answer before it is sent again. A
/// lost UDP packet costs this long, not the whole budget.
const DNS_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);
/// Times a query is sent before the lookup counts as failed; the callers'
/// budgets end it sooner.
const DNS_ATTEMPTS: usize = 3;

/// The client's reverse DNS, looked up when the connection opens.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReverseDns {
    /// First PTR name, without the trailing dot.
    pub name: Option<String>,
    /// The PTR name resolves back to the client's address.
    pub confirmed: bool,
    /// The lookup could not finish (a timeout, SERVFAIL), so nothing is
    /// known: neither a pass nor a fail.
    pub temporary_error: bool,
}

impl ReverseDns {
    /// A lookup that ran out of time before it had an answer.
    pub fn incomplete() -> Self {
        Self {
            temporary_error: true,
            ..Self::default()
        }
    }

    /// RFC 8601's iprev result.
    pub fn iprev_result(&self) -> &'static str {
        if self.confirmed {
            "pass"
        } else if self.temporary_error {
            "temperror"
        } else {
            "fail"
        }
    }
}

/// A receiver for a reverse lookup that outlived the connection's wait:
/// `None` until it has finished.
pub type LateReverseDns = tokio::sync::watch::Receiver<Option<ReverseDns>>;

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
    /// Asks `dns_servers`, or the system's resolvers when the list is empty.
    /// Without a resolver the checks are skipped and reported as unavailable.
    pub fn new(hostname: &str, budget: Duration, slots: usize, dns_servers: &[SocketAddr]) -> Self {
        let authenticator = match authenticator(dns_servers) {
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
    /// so it runs on the async runtime. Running out of time is a temporary
    /// error, as is any failure other than "no such record".
    pub async fn reverse_dns(&self, ip: IpAddr, budget: Duration) -> ReverseDns {
        let Some(authenticator) = &self.authenticator else {
            return ReverseDns::default();
        };
        let lookup = async {
            let no_cache = None::<&NoCache<IpAddr, RecordSet<Box<str>>>>;
            let names = match authenticator.ptr_lookup(ip, no_cache).await {
                Ok(ptr) => ptr
                    .rrset
                    .iter()
                    .take(MAX_PTR_NAMES)
                    .map(|name| name.trim_end_matches('.').to_ascii_lowercase())
                    .collect(),
                Err(e) if is_absent(&e) => Vec::new(),
                Err(_) => return ReverseDns::incomplete(),
            };
            first_confirmed(names, |name| forward(authenticator, name, ip)).await
        };
        tokio::time::timeout(budget, lookup)
            .await
            .unwrap_or_else(|_| ReverseDns::incomplete())
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
        let mut json = bounded(&self.slots, deadline, move || {
            runtime.block_on(async {
                tokio::time::timeout_at(
                    deadline,
                    run(&authenticator, &hostname, &request, deadline),
                )
                .await
                .ok()
            })
        })
        .await;
        fit(&mut json);
        AuthOutcome { json }
    }
}

/// Keeps the document under `MAX_AUTH_JSON_BYTES`: the sender-setup facts
/// go first, then the ARC sealers. The verdicts themselves are small.
fn fit(json: &mut Value) {
    without_nul(json);
    let size = |json: &Value| serde_json::to_string(json).map_or(usize::MAX, |s| s.len());
    if size(json) <= MAX_AUTH_JSON_BYTES {
        return;
    }
    if json.get("setup").is_some() {
        json["setup"] = json!({ "error": "too large" });
    }
    if size(json) > MAX_AUTH_JSON_BYTES
        && let Some(arc) = json.get_mut("arc").and_then(Value::as_object_mut)
    {
        arc.remove("sealers");
    }
    // The header written for the user repeats what the fields say.
    if size(json) > MAX_AUTH_JSON_BYTES
        && let Some(map) = json.as_object_mut()
    {
        map.remove("authentication_results");
    }
    // Signatures past the first ones, last: what is left still has to fit,
    // or the receiver keeps no verdict at all.
    while size(json) > MAX_AUTH_JSON_BYTES {
        match json.get_mut("dkim").and_then(Value::as_array_mut) {
            Some(signatures) if !signatures.is_empty() => {
                signatures.pop();
            }
            _ => break,
        }
    }
}

/// Removes NUL from every string, and the text `\u0000` too: jsonb refuses
/// the one, and the receiver drops a document whose JSON contains the other
/// (it cannot tell them apart). Names come from the sender's DNS and headers.
fn without_nul(json: &mut Value) {
    match json {
        Value::String(text) => {
            if text.contains('\0') || text.contains("\\u0000") {
                *text = nul_free(text);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(without_nul),
        Value::Object(map) => map.values_mut().for_each(without_nul),
        _ => {}
    }
}

/// `text` without NUL and without a backslash before any `u0000`, in one
/// pass: a sender controls these strings (a DKIM `i=` of 100,000
/// backslashes), so the work must stay linear. Each backslash is dropped at
/// most once, and a run of them is dropped whole, so none can come to stand
/// before a `u0000` again.
fn nul_free(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().filter(|&c| c != '\0') {
        out.push(c);
        if out.ends_with("u0000") {
            let stem = out.len() - "u0000".len();
            let slashes = out.as_bytes()[..stem]
                .iter()
                .rev()
                .take_while(|&&b| b == b'\\')
                .count();
            if slashes > 0 {
                out.replace_range(stem - slashes..stem, "");
            }
        }
    }
    out
}

/// The resolver every check uses: `servers`, or the system's resolvers, with
/// retries tuned for checks that have a few seconds each.
fn authenticator(servers: &[SocketAddr]) -> Result<MessageAuthenticator, String> {
    let (config, mut options) = if servers.is_empty() {
        read_system_conf().map_err(|e| e.to_string())?
    } else {
        let servers = servers
            .iter()
            .map(|server| {
                let mut config = NameServerConfig::udp_and_tcp(server.ip());
                for connection in &mut config.connections {
                    connection.port = server.port();
                }
                config
            })
            .collect();
        (
            ResolverConfig::from_name_servers(servers),
            ResolverOpts::default(),
        )
    };
    tune(&mut options);
    MessageAuthenticator::new(config, options).map_err(|e| e.to_string())
}

/// resolv.conf's defaults wait 5 s for each answer; a lost packet would use
/// up a check's whole budget.
fn tune(options: &mut ResolverOpts) {
    options.timeout = DNS_ATTEMPT_TIMEOUT;
    options.attempts = DNS_ATTEMPTS;
}

/// The lookup finished and found nothing: the name or record does not exist
/// (NXDOMAIN, or no data), or it is not one a lookup can be made for. Any
/// other error means the lookup did not finish.
fn is_absent(error: &mail_auth::Error) -> bool {
    matches!(
        error,
        mail_auth::Error::Dns(DnsError::RecordNotFound(_) | DnsError::InvalidRecordType)
            | mail_auth::Error::ParseError
    )
}

/// What a forward lookup of a name (a PTR name, the HELO name) says about
/// the client's address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Forward {
    Matches,
    /// The name has addresses, or definitely none, and the client's is not
    /// among them.
    Differs,
    /// The lookup did not finish.
    Failed,
}

/// The PTR names to look at; more are ignored.
const MAX_PTR_NAMES: usize = 4;

/// The first PTR name that resolves back to the client, checked name by
/// name. An overall "some name matched" is not enough: a sender that controls
/// its reverse zone could list a provider's name it does not own next to its
/// own confirmed one.
///
/// When no name matched and a forward lookup did not finish, the answer is a
/// temporary error: that name might have matched.
async fn first_confirmed<F, Fut>(names: Vec<String>, mut forward_of: F) -> ReverseDns
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Forward>,
{
    let mut unfinished = false;
    for name in &names {
        match forward_of(name.clone()).await {
            Forward::Matches => {
                return ReverseDns {
                    name: Some(name.clone()),
                    confirmed: true,
                    temporary_error: false,
                };
            }
            Forward::Differs => {}
            Forward::Failed => unfinished = true,
        }
    }
    ReverseDns {
        name: names.into_iter().next(),
        confirmed: false,
        temporary_error: unfinished,
    }
}

/// Whether `name` resolves to `ip`, telling a lookup that did not finish
/// apart from one that found other addresses or none.
pub(crate) async fn forward(
    authenticator: &MessageAuthenticator,
    name: String,
    ip: IpAddr,
) -> Forward {
    let found = match ip {
        IpAddr::V4(v4) => authenticator
            .ipv4_lookup(
                name.as_str(),
                None::<&NoCache<Box<str>, RecordSet<Ipv4Addr>>>,
            )
            .await
            .map(|found| found.rrset.contains(&v4)),
        IpAddr::V6(v6) => authenticator
            .ipv6_lookup(
                name.as_str(),
                None::<&NoCache<Box<str>, RecordSet<Ipv6Addr>>>,
            )
            .await
            .map(|found| found.rrset.contains(&v6)),
    };
    match found {
        Ok(true) => Forward::Matches,
        Ok(false) => Forward::Differs,
        Err(e) if is_absent(&e) => Forward::Differs,
        Err(_) => Forward::Failed,
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

/// The sender-setup facts by `deadline`, or why there are none.
async fn setup_within(
    authenticator: &MessageAuthenticator,
    setup: &SetupInput<'_>,
    deadline: Instant,
) -> Value {
    tokio::time::timeout_at(deadline, sender_setup(&LiveDns(authenticator), setup))
        .await
        .unwrap_or_else(|_| json!({ "error": "timeout" }))
}

async fn run(
    authenticator: &MessageAuthenticator,
    hostname: &str,
    request: &AuthRequest,
    deadline: Instant,
) -> Value {
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
            "result": request.reverse_dns.iprev_result(),
            "ptr": request.reverse_dns.name,
        },
    });
    let mut setup = SetupInput {
        ip: request.ip,
        helo,
        reverse_dns: &request.reverse_dns,
        spf_domain: spf.domain(),
        from_domain: None,
        dkim: Vec::new(),
        dmarc: None,
    };
    let setup_deadline = deadline.checked_sub(SETUP_MARGIN).unwrap_or(deadline);

    if let Some(reason) = dkim_skip_reason(&request.raw) {
        json["dkim"] = json!([]);
        json["dmarc"] = json!({ "result": "skipped", "reason": reason });
        json["arc"] = json!({ "result": "skipped", "reason": reason });
        json["setup"] = setup_within(authenticator, &setup, setup_deadline).await;
        return json;
    }
    let Some(message) = AuthenticatedMessage::parse(&request.raw) else {
        json["dkim"] = json!([]);
        json["dmarc"] = json!({ "result": "none" });
        json["arc"] = json!({ "result": "none", "sets": 0 });
        json["setup"] = setup_within(authenticator, &setup, setup_deadline).await;
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
                    "domain": signature.map(|s| clip(&s.d)),
                    "selector": signature.map(|s| clip(&s.s)),
                })
            })
            .collect(),
    );
    // mail-auth's own verdict: with a record and nothing aligned it is a
    // failure, even when neither mechanism produced a result of its own
    // (SPF failed and no signature passed); "none" only without a record.
    json["dmarc"] = json!({
        "result": dmarc_result(&dmarc.result()),
        "domain": clip(dmarc.domain()),
        "policy": policy(dmarc.policy()),
        "spf": dmarc_result(dmarc.spf_result()),
        "dkim": dmarc_result(dmarc.dkim_result()),
    });

    setup.from_domain = (!dmarc.domain().is_empty()).then(|| dmarc.domain());
    setup.dkim = dkim
        .iter()
        .filter_map(|output| output.signature())
        .map(|s| (s.d.clone(), s.s.clone(), s.a))
        .collect();
    setup.dmarc = dmarc.dmarc_record();

    // ARC and the sender's setup need nothing from each other, so they run
    // side by side after the verdicts above, each within the setup
    // deadline: a sealer's slow nameserver costs neither the verdicts nor
    // the setup facts.
    let skip_arc = arc_skip_reason(&request.raw);
    let (arc, setup_json) = tokio::join!(
        async {
            match skip_arc {
                Some(_) => None,
                None => tokio::time::timeout_at(setup_deadline, authenticator.verify_arc(&message))
                    .await
                    .ok(),
            }
        },
        setup_within(authenticator, &setup, setup_deadline),
    );
    json["arc"] = match (&arc, skip_arc) {
        (_, Some(reason)) => json!({ "result": "skipped", "reason": reason }),
        (None, None) => json!({ "result": "skipped", "reason": "timeout" }),
        (Some(arc), None) => json!({
            "result": dkim_result(arc.result()),
            "sets": arc.sets().len(),
            "sealers": arc
                .sets()
                .iter()
                .map(|set| clip(&set.seal.header.d))
                .collect::<Vec<_>>(),
        }),
    };
    json["setup"] = setup_json;

    let mut results = AuthenticationResults::new(hostname)
        .with_dkim_results(&dkim, message.from())
        .with_spf_mailfrom_result(&spf, request.ip, mail_from, helo);
    if let Some(arc) = &arc {
        results = results.with_arc_result(arc, request.ip);
    }
    results = results.with_dmarc_result(&dmarc);
    json["authentication_results"] = Value::String(results.to_string());
    json
}

/// A domain or selector from a header, at most `MAX_DOMAIN_CHARS` long.
fn clip(name: &str) -> String {
    name.chars().take(MAX_DOMAIN_CHARS).collect()
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

/// The header section's fields, unfolded; `Err` when it is too large to
/// verify anything in.
fn header_fields(raw: &[u8]) -> Result<Vec<String>, &'static str> {
    let end = header_section_end(raw).unwrap_or(raw.len());
    if end > MAX_AUTH_HEADER_BYTES {
        return Err("header section too large");
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
    Ok(fields)
}

/// The values of the fields named `name`.
fn values<'a>(fields: &'a [String], name: &'a str) -> impl Iterator<Item = &'a str> {
    fields.iter().filter_map(move |field| {
        let (field_name, value) = field.split_once(':')?;
        field_name
            .trim()
            .eq_ignore_ascii_case(name)
            .then_some(value)
    })
}

/// A signature whose `h=` list names more headers than anyone signs.
fn signs_too_many_headers(value: &str) -> bool {
    value.split(';').any(|tag| {
        tag.split_once('=').is_some_and(|(tag_name, list)| {
            tag_name.trim().eq_ignore_ascii_case("h")
                && list.split(':').count() > MAX_SIGNED_HEADERS
        })
    })
}

/// Why DKIM and DMARC must not run on this message, if they must not.
fn dkim_skip_reason(raw: &[u8]) -> Option<&'static str> {
    let fields = match header_fields(raw) {
        Ok(fields) => fields,
        Err(reason) => return Some(reason),
    };
    let mut signatures = 0;
    for value in values(&fields, "dkim-signature") {
        signatures += 1;
        if signatures > MAX_DKIM_SIGNATURES {
            return Some("too many DKIM signatures");
        }
        if signs_too_many_headers(value) {
            return Some("too many signed headers");
        }
    }
    None
}

/// Why ARC must not run on this message, if it must not. Checked after
/// `dkim_skip_reason`, so the header section is within bounds.
fn arc_skip_reason(raw: &[u8]) -> Option<&'static str> {
    let fields = match header_fields(raw) {
        Ok(fields) => fields,
        Err(reason) => return Some(reason),
    };
    if values(&fields, "arc-seal").count() > MAX_ARC_SETS
        || values(&fields, "arc-message-signature").count() > MAX_ARC_SETS
    {
        return Some("too many ARC sets");
    }
    if values(&fields, "arc-message-signature").any(signs_too_many_headers) {
        return Some("too many signed headers");
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
    async fn trusts_only_the_ptr_name_that_resolves_back() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let matching = |wanted: &'static str| {
            move |n: String| {
                std::future::ready(if n == wanted {
                    Forward::Matches
                } else {
                    Forward::Differs
                })
            }
        };
        // A provider's name listed first, the sender's own second: only the
        // second one resolves back to the client.
        let found = first_confirmed(
            names(&["smtp.google.com", "mail.attacker.test"]),
            matching("mail.attacker.test"),
        )
        .await;
        assert_eq!(
            found,
            ReverseDns {
                name: Some("mail.attacker.test".into()),
                confirmed: true,
                temporary_error: false,
            }
        );
        let none = first_confirmed(names(&["a.test", "b.test"]), matching("c.test")).await;
        assert_eq!(
            none,
            ReverseDns {
                name: Some("a.test".into()),
                ..ReverseDns::default()
            }
        );
        assert_eq!(none.iprev_result(), "fail");
        assert_eq!(
            first_confirmed(vec![], |_| std::future::ready(Forward::Matches)).await,
            ReverseDns::default()
        );
    }

    #[tokio::test]
    async fn a_forward_lookup_that_did_not_finish_is_a_temporary_error() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // The first name timed out, the second resolves elsewhere: the first
        // might have matched, so nothing is known.
        let unknown = first_confirmed(names(&["a.test", "b.test"]), |n| {
            std::future::ready(if n == "a.test" {
                Forward::Failed
            } else {
                Forward::Differs
            })
        })
        .await;
        assert_eq!(
            unknown,
            ReverseDns {
                name: Some("a.test".into()),
                confirmed: false,
                temporary_error: true,
            }
        );
        assert_eq!(unknown.iprev_result(), "temperror");
        // A later name that matches still passes.
        let found = first_confirmed(names(&["a.test", "b.test"]), |n| {
            std::future::ready(if n == "a.test" {
                Forward::Failed
            } else {
                Forward::Matches
            })
        })
        .await;
        assert_eq!(found.iprev_result(), "pass");
        assert!(!found.temporary_error);
    }

    #[test]
    fn only_a_missing_record_is_a_definite_answer() {
        use mail_auth::hickory_resolver::proto::op::ResponseCode;
        assert!(is_absent(&mail_auth::Error::Dns(DnsError::RecordNotFound(
            ResponseCode::NXDomain
        ))));
        assert!(is_absent(&mail_auth::Error::Dns(DnsError::RecordNotFound(
            ResponseCode::NoError
        ))));
        assert!(!is_absent(&mail_auth::Error::Dns(DnsError::Resolver(
            "request timed out".into()
        ))));
        assert!(!is_absent(&mail_auth::Error::Io("reset".into())));
        assert_eq!(ReverseDns::incomplete().iprev_result(), "temperror");
        assert_eq!(ReverseDns::default().iprev_result(), "fail");
    }

    #[test]
    fn retries_dns_queries_well_inside_the_budgets() {
        let mut options = ResolverOpts::default();
        tune(&mut options);
        assert_eq!(options.timeout, DNS_ATTEMPT_TIMEOUT);
        assert_eq!(options.attempts, DNS_ATTEMPTS);
        assert!(options.cache_size > 0, "answers are kept across messages");
        let defaults = crate::config::Timeouts::default();
        assert!(DNS_ATTEMPT_TIMEOUT < defaults.reverse_dns);
        assert!(DNS_ATTEMPT_TIMEOUT * 2 < defaults.auth_checks);
    }

    /// A DNS server on a loopback port that answers every query with
    /// `rcode`, or never answers when it is `None`.
    async fn fake_dns(rcode: Option<u8>) -> SocketAddr {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            while let Ok((n, from)) = socket.recv_from(&mut buf).await {
                let Some(rcode) = rcode else { continue };
                // The query itself, turned into a response: QR and RA set,
                // the answer code in the low bits of the fourth byte.
                let mut reply = buf[..n].to_vec();
                reply[2] |= 0x80;
                reply[3] = 0x80 | rcode;
                let _ = socket.send_to(&reply, from).await;
            }
        });
        address
    }

    fn checker_asking(server: SocketAddr) -> AuthChecker {
        AuthChecker::new("mx.example", Duration::from_secs(1), 1, &[server])
    }

    #[tokio::test]
    async fn a_lookup_that_got_no_answer_is_a_temporary_error() {
        let checker = checker_asking(fake_dns(None).await);
        let found = checker
            .reverse_dns("192.0.2.1".parse().unwrap(), Duration::from_millis(300))
            .await;
        assert_eq!(found, ReverseDns::incomplete());
        assert_eq!(found.iprev_result(), "temperror");
    }

    #[tokio::test]
    async fn servfail_is_a_temporary_error_and_nxdomain_a_failure() {
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let servfail = checker_asking(fake_dns(Some(2)).await);
        assert_eq!(
            servfail.reverse_dns(ip, Duration::from_secs(5)).await,
            ReverseDns::incomplete()
        );
        let nxdomain = checker_asking(fake_dns(Some(3)).await);
        let found = nxdomain.reverse_dns(ip, Duration::from_secs(5)).await;
        assert_eq!(found, ReverseDns::default());
        assert_eq!(found.iprev_result(), "fail");
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
    fn drops_setup_facts_before_the_document_gets_too_large() {
        let mut small = json!({ "spf": { "result": "pass" }, "setup": { "helo": {} } });
        let before = small.clone();
        fit(&mut small);
        assert_eq!(small, before);
        let mut large = json!({
            "spf": { "result": "pass" },
            "arc": { "result": "pass", "sealers": ["x".repeat(15 * 1024)] },
            "setup": { "spf": { "record": "y".repeat(10 * 1024) } },
        });
        fit(&mut large);
        assert_eq!(large["setup"], json!({ "error": "too large" }));
        // Long signature names (each clipped, but ten of them) still fit.
        let mut signed = json!({
            "spf": { "result": "pass" },
            "dkim": (0..10).map(|_| json!({ "result": "fail", "domain": "d".repeat(253), "selector": "s".repeat(1500) })).collect::<Vec<_>>(),
            "authentication_results": "a".repeat(4000),
        });
        fit(&mut signed);
        assert!(serde_json::to_string(&signed).unwrap().len() <= MAX_AUTH_JSON_BYTES);
        assert!(signed.get("authentication_results").is_none());
        assert!(!signed["dkim"].as_array().unwrap().is_empty());
        assert_eq!(signed["spf"], json!({ "result": "pass" }));
        assert_eq!(large["arc"], json!({ "result": "pass" }));
        assert_eq!(large["spf"], json!({ "result": "pass" }));
    }

    #[test]
    fn leaves_no_nul_for_the_receiver_to_refuse() {
        let mut json = json!({
            "dkim": [{ "domain": "a\0b.example" }],
            "setup": { "spf": { "record": "v=spf1 \\u0000 \\\\u0000 -all" } },
        });
        fit(&mut json);
        assert_eq!(json["dkim"][0]["domain"], json!("ab.example"));
        let text = serde_json::to_string(&json).unwrap();
        assert!(!text.contains("\\u0000"), "{text}");
    }

    #[test]
    fn removes_nul_in_linear_time() {
        assert_eq!(nul_free("a\\\\\\u0000b\0c"), "au0000bc");
        assert_eq!(nul_free("\\u00\\u0000"), "\\u00u0000");
        assert_eq!(nul_free("plain \\n text"), "plain \\n text");
        // A sender's DKIM i= can hold this many; the old loop took minutes.
        let hostile = format!("{}u0000", "\\".repeat(200_000)).repeat(3);
        let started = std::time::Instant::now();
        let clean = nul_free(&hostile);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(clean, "u0000u0000u0000");
        let mut json = json!({ "authentication_results": hostile });
        fit(&mut json);
        assert!(!serde_json::to_string(&json).unwrap().contains("\\u0000"));
    }

    #[test]
    fn skips_arc_for_abusive_chains_only() {
        let set = "ARC-Seal: i=1; a=rsa-sha256; d=example.net; s=a; cv=none; b=x\r\nARC-Message-Signature: i=1; d=example.net; s=a; h=from:to; bh=y; b=z\r\n";
        let ordinary = format!("{set}From: a@example.com\r\n\r\nbody\r\n");
        assert_eq!(arc_skip_reason(ordinary.as_bytes()), None);
        let long = format!(
            "{}From: a@example.com\r\n\r\nbody\r\n",
            set.repeat(MAX_ARC_SETS + 1)
        );
        assert_eq!(arc_skip_reason(long.as_bytes()), Some("too many ARC sets"));
        let many_h = (0..=MAX_SIGNED_HEADERS)
            .map(|i| format!("x{i}"))
            .collect::<Vec<_>>()
            .join(":");
        let wide =
            format!("ARC-Message-Signature: i=1; d=example.net; h={many_h}; b=z\r\n\r\nbody\r\n");
        assert_eq!(
            arc_skip_reason(wide.as_bytes()),
            Some("too many signed headers")
        );
    }

    #[test]
    fn finds_the_end_of_the_header_section() {
        assert_eq!(header_section_end(b"A: b\r\n\r\nbody"), Some(8));
        assert_eq!(header_section_end(b"A: b\n\nbody"), Some(6));
        assert_eq!(header_section_end(b"A: b\r\n"), None);
    }
}
